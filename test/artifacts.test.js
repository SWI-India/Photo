const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { buildReportDocument, watermarkPhoto } = require("../src/drive");

const sampleReport = {
  personName: "Test User",
  villageName: "Test Village",
  reportType: "Refill Visit",
  reportDate: "2026-06-18",
  submittedAt: "18 Jun 2026, 10:00 am",
  reportText: "Completed the scheduled village visit.",
  latitude: 20.5937,
  longitude: 78.9629
};

test("buildReportDocument creates a Word document", async () => {
  const buffer = await buildReportDocument(sampleReport);
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000);
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
});

test("watermarkPhoto creates a readable JPEG artifact", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "swi-watermark-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "photo.png");
  await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: { r: 220, g: 225, b: 218 }
    }
  }).png().toFile(input);

  const result = await watermarkPhoto({
    path: input,
    originalname: "photo.png",
    captureDate: "18 Jun 2026, 9:30 am"
  }, sampleReport);

  const metadata = await sharp(result.path).metadata();
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 800);
  fs.rmSync(result.path, { force: true });
});
