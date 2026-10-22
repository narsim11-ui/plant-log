# Plant Log

A care logbook for a home plant collection. It's a phone web app that installs to the Android home screen.
Your data is stored in your own Google Drive: a Google Sheet holds the log, and a Drive folder holds the photos.

- Plants are grouped by location, in the order you water them. Tap a plant's button once to log its next rotation step.
- Feed rotations (e.g. 19:19:19 → Seaweed → 19:19:19 → Plain) are assigned per plant, and the app tracks which step comes next.
- A drying estimate is calculated from the last 10 clean watering intervals. It resets on a repot and ignores trips and waterings done by a helper.
- Dated photo sessions, a Day 0 flag, and side-by-side comparison of any two sessions.
- Charts for days between waterings (with trip and repot markers) and the feed mix, plus a collection overview.
- Works offline: entries queue on the phone and sync when it's back online.

## How it fits together

```
Phone (this app, GitHub Pages) ──POST──> Google Apps Script (runs as you) ──> Sheet "Plant Log — Data"
                                                                      └──> Drive "Plant Log/Photos/<plant>/"
```

`apps-script/Code.gs` is the backend. Paste it into script.google.com once (setup steps are below).
No Google Cloud project, no billing, no API keys. The app talks to the script using a private key
that the script generates the first time it runs.

## Setup

1. **Turn on GitHub Pages:** repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
   About a minute later the app is live at `https://<username>.github.io/plant-log/`.
2. **Create the backend:** follow the Apps Script steps in the setup message, or the comment at the top of `apps-script/Code.gs`.
3. **Connect the app:** open the app → ⚙ Settings → paste the Web app URL and the App key → **Save & test**.
4. **Install:** in Chrome on Android, open the app → ⋮ menu → **Add to Home screen → Install**.

## Updating

App updates arrive automatically: the phone uses the cached version and fetches the new one in the
background, so a change shows up on the second open after it's pushed. If `Code.gs` changes, redeploy it in
Apps Script with **Deploy → Manage deployments → ✎ → Version: New version → Deploy**. The URL stays the same.
