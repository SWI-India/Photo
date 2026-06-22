const fs = require("node:fs");
const path = require("node:path");
const { google } = require("googleapis");
const { Document, Packer, Paragraph, HeadingLevel } = require("docx");
const sharp = require("sharp");
const { getSetting, setSetting } = require("./db");

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;

  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const refreshToken = getSetting("google_refresh_token");
  if (refreshToken) client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function requireDrive() {
  const auth = getOAuthClient();
  if (!auth || !getSetting("google_refresh_token")) {
    const error = new Error("Google Drive is not connected. Ask an administrator to connect it.");
    error.code = "DRIVE_NOT_CONNECTED";
    throw error;
  }
  return google.drive({ version: "v3", auth });
}

async function findOrCreateFolder(drive, name, parentId) {
  const escaped = name.replace(/'/g, "\\'");
  const parentClause = parentId ? ` and '${parentId}' in parents` : "";
  const result = await drive.files.list({
    q: `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`,
    fields: "files(id,name)",
    spaces: "drive"
  });
  if (result.data.files.length) return result.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined
    },
    fields: "id"
  });
  return created.data.id;
}

async function ensureReportFolder(village, date, reportType) {
  const drive = requireDrive();
  let rootId = getSetting("drive_root_folder_id");
  if (!rootId) {
    rootId = await findOrCreateFolder(drive, "SWI Field Reports");
    setSetting("drive_root_folder_id", rootId);
  }
  const villageId = await findOrCreateFolder(drive, village, rootId);
  const dateFolderName = `${date} ${reportType || "General Visit"}`;
  const dateId = await findOrCreateFolder(drive, dateFolderName, villageId);
  return { drive, folderId: dateId };
}

async function buildReportDocument(report) {
  const location = report.latitude != null && report.longitude != null
    ? `${report.latitude}, ${report.longitude}`
    : "Not captured";
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ text: "SWI Daily Field Report", heading: HeadingLevel.TITLE }),
        new Paragraph({ text: `Field person: ${report.personName}` }),
        new Paragraph({ text: `Village: ${report.villageName}` }),
        new Paragraph({ text: `Date: ${report.reportDate}` }),
        new Paragraph({ text: `Report type: ${report.reportType || "General Visit"}` }),
        new Paragraph({ text: `Submitted: ${report.submittedAt}` }),
        new Paragraph({ text: `GPS location: ${location}` }),
        new Paragraph({ text: "Report", heading: HeadingLevel.HEADING_1 }),
        ...report.reportText.split(/\r?\n/).map((line) => new Paragraph(line || " "))
      ]
    }]
  });
  return Packer.toBuffer(document);
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
  })[character]);
}

async function watermarkPhoto(file, report) {
  const metadata = await sharp(file.path).metadata();
  const width = metadata.width || 1600;
  const fontSize = Math.max(24, Math.round(width * 0.026));
  const padding = Math.max(22, Math.round(width * 0.025));
  const lineHeight = Math.round(fontSize * 1.35);
  const location = report.latitude != null && report.longitude != null
    ? `GPS: ${report.latitude.toFixed(6)}, ${report.longitude.toFixed(6)}`
    : "GPS: Not captured";
  const lines = [
    `${report.villageName} | ${report.reportType || "General Visit"} | ${file.captureDate || report.submittedAt}`,
    `${report.personName} | ${location}`
  ];
  const bannerHeight = padding * 2 + lineHeight * lines.length;
  const text = lines.map((line, index) =>
    `<text x="${padding}" y="${padding + fontSize + index * lineHeight}" fill="white" font-size="${fontSize}" font-family="Arial, sans-serif" font-weight="600">${escapeXml(line)}</text>`
  ).join("");
  const overlay = Buffer.from(`
    <svg width="${width}" height="${bannerHeight}">
      <rect width="100%" height="100%" fill="rgba(12, 32, 23, 0.78)"/>
      ${text}
    </svg>
  `);
  const outputPath = `${file.path}-watermarked.jpg`;
  await sharp(file.path)
    .rotate()
    .composite([{ input: overlay, gravity: "south" }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(outputPath);
  return {
    path: outputPath,
    mimeType: "image/jpeg",
    name: `${path.parse(file.originalname).name}-watermarked.jpg`
  };
}

async function uploadReportBundle(report, files) {
  const { drive, folderId } = await ensureReportFolder(report.villageName, report.reportDate, report.reportType);
  const uploaded = [];

  for (const file of files) {
    let prepared = { path: file.path, mimeType: file.mimetype, name: file.originalname };
    try {
      if (file.mimetype.startsWith("image/")) prepared = await watermarkPhoto(file, report);
      const response = await drive.files.create({
        requestBody: { name: prepared.name, parents: [folderId] },
        media: { mimeType: prepared.mimeType, body: fs.createReadStream(prepared.path) },
        fields: "id,webViewLink"
      });
      await drive.permissions.create({
        fileId: response.data.id,
        requestBody: { role: "reader", type: "anyone" }
      });
      uploaded.push({
        originalName: prepared.name,
        mimeType: prepared.mimeType,
        driveFileId: response.data.id,
        publicUrl: response.data.webViewLink
      });
    } finally {
      if (prepared.path !== file.path) fs.rm(prepared.path, { force: true }, () => {});
    }
  }

  const documentBuffer = await buildReportDocument(report);
  const { Readable } = require("node:stream");
  const documentName = `${report.reportDate} - ${report.reportType || "General Visit"} - ${report.personName} - Daily Report.docx`;
  const documentResponse = await drive.files.create({
    requestBody: { name: documentName, parents: [folderId] },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      body: Readable.from(documentBuffer)
    },
    fields: "id"
  });

  return {
    folderId,
    documentId: documentResponse.data.id,
    media: uploaded
  };
}

async function startResumableUpload({ folderId, name, mimeType, size }) {
  const auth = getOAuthClient();
  if (!auth || !getSetting("google_refresh_token")) {
    const error = new Error("Google Drive is not connected. Ask an administrator to connect it.");
    error.code = "DRIVE_NOT_CONNECTED";
    throw error;
  }
  const token = await auth.getAccessToken();
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.token || token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(size)
    },
    body: JSON.stringify({
      name,
      parents: [folderId]
    })
  });
  if (!response.ok) {
    throw new Error(`Could not start Google Drive upload (${response.status}).`);
  }
  return response.headers.get("location");
}

async function uploadResumableChunk({ uploadUrl, chunk, mimeType, start, end, total }) {
  const auth = getOAuthClient();
  const token = auth ? await auth.getAccessToken() : null;
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      ...(token ? { Authorization: `Bearer ${token.token || token}` } : {}),
      "Content-Length": String(chunk.length),
      "Content-Type": mimeType,
      "Content-Range": `bytes ${start}-${end}/${total}`
    },
    body: chunk
  });
  if (response.status === 308) {
    const range = response.headers.get("range");
    const uploadedBytes = range ? Number(range.split("-").pop()) + 1 : end + 1;
    return { done: false, uploadedBytes };
  }
  if (response.ok) {
    const data = await response.json();
    return { done: true, uploadedBytes: total, fileId: data.id, publicUrl: data.webViewLink };
  }
  if (response.status === 404) {
    const error = new Error("The Google Drive upload session expired. Please retry the report upload.");
    error.code = "DRIVE_SESSION_EXPIRED";
    throw error;
  }
  throw new Error(`Google Drive chunk upload failed (${response.status}).`);
}

async function shareDriveFile(fileId) {
  const drive = requireDrive();
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" }
  });
}

async function getDriveFileStream(fileId, range) {
  const drive = requireDrive();
  return drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream", headers: range ? { Range: range } : undefined }
  );
}

async function getConnectionStatus() {
  const auth = getOAuthClient();
  if (!auth || !getSetting("google_refresh_token")) {
    return { connected: false, email: null };
  }
  try {
    const oauth2 = google.oauth2({ version: "v2", auth });
    const profile = await oauth2.userinfo.get();
    return { connected: true, email: profile.data.email };
  } catch {
    return { connected: false, email: getSetting("google_account_email") };
  }
}

module.exports = {
  getOAuthClient,
  uploadReportBundle,
  getConnectionStatus,
  buildReportDocument,
  watermarkPhoto,
  startResumableUpload,
  uploadResumableChunk,
  shareDriveFile,
  getDriveFileStream
};
