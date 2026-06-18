# SWI Field Reports

An installable mobile web app for village field reports, photos and videos. Reports are stored as `.docx` files in Google Drive alongside their media.

## Included

- Field-user and administrator login
- Village dropdown managed by an administrator
- Daily report with a 3,000-character limit
- Up to 10 photos/videos per report
- GPS capture
- Google Drive folders: `SWI Field Reports / Village / YYYY-MM-DD`
- Word document generated in the same dated folder
- Public report page and WhatsApp sharing
- Stable village-level link showing all submitted reports
- Visible village, date, field-person and GPS watermark on uploaded photos
- Google account reconnect/change flow
- Installable Android PWA
- Offline report queue with automatic retry when connectivity returns

## Local setup

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and replace `JWT_SECRET` and the initial password.
4. In Google Cloud Console, create a project using `sindhjirasoi@gmail.com`.
5. Enable the Google Drive API.
6. Configure the OAuth consent screen and create a Web application OAuth client.
7. Add `http://localhost:3000/api/admin/google/callback` as an authorised redirect URI.
8. Put the client ID and secret in `.env`.
9. Run `npm start`.
10. Sign in with the initial administrator credentials and connect `sindhjirasoi@gmail.com` under Admin.

## Production requirements

- Host the Node service on an HTTPS domain.
- Change `APP_URL` and `GOOGLE_REDIRECT_URI` to the production HTTPS URLs.
- Add the production callback URL in Google Cloud Console.
- Use a persistent disk for the `data` directory.
- Set `DATA_DIR` to a persistent, non-synced disk directory. SQLite should not run directly inside OneDrive.
- Set a long random `JWT_SECRET`.
- Change the initial administrator password before field use.

Google requires the account owner to approve Drive access through its OAuth screen. Passwords and Google refresh tokens must not be committed to source control.

## Render deployment

The included `render.yaml` creates a Starter web service and a 1 GB persistent disk.
After deployment, set `APP_URL` and `GOOGLE_REDIRECT_URI` to the final HTTPS Render URL.
