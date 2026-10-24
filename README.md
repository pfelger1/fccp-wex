# FCCP WEX Timekeeping - participant site

The website WEX participants use to clock in and out, add missed shifts, request sick time and sign their timecard.
All data stays in FCCP's Google Sheets; this site only shows the screens and talks to the
"WEX Timesheet System" Google Apps Script web app.

- `config.js` - the Apps Script web-app address and whether this is the test or production site.
- `app.js` - the screens and logic. `styles.css` - the look.
- Published with GitHub Pages at https://wex.thefccp.org (see `CNAME`).

No participant data, PINs or passwords are stored in this repository.
