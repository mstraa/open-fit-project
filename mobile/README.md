# Open Fit — Android app (Phase 2)

GPL Android app = the **React web UI** (in `../web`) wrapped by **Capacitor**, so the
phone runs the same Open Fit dashboard / activities / wellness — no second UI to
maintain. On top of that it adds the **Gadgetbridge bridge** and (later) direct BLE:

- **2a (interop):** read Gadgetbridge's exported SQLite DB (and/or Health Connect)
  on-device → map wellness (HR / sleep / steps) + activities → relay to your
  self-hosted `ofit-api` (`POST /api/wellness`, file import). Cloudless, local.
- **2b (embedded, later):** vendor Gadgetbridge's device modules → direct BLE hub.

## Why Capacitor
Reuses 100% of the web frontend; native plugins cover what the web can't
(`@capacitor-community/sqlite` to open the Gadgetbridge DB, BLE later). GPL-compatible.

## Build / run
Needs the Android SDK + a JDK (21 works) and `ANDROID_HOME` set.

```sh
cd mobile
npm install
npm run sync          # builds ../web and copies it + syncs the native project
# debug APK:
cd android && ANDROID_HOME=~/Library/Android/sdk ./gradlew assembleDebug
#   → app/build/outputs/apk/debug/app-debug.apk   (install with: adb install -r <apk>)
# or open in Android Studio:  (from mobile/)  npm run open
```

`cap sync` regenerates the copied web assets + native config (gitignored), so after a
fresh clone run `npm install && npm run sync` before building.

## Configure the server
The app talks to **your** ofit-api over the LAN (plain http is allowed). The API base
URL is set at runtime in-app (Settings → server URL), not baked into the build, so one
APK works against any self-hosted instance.

## Export the Gadgetbridge DB (to feed the bridge)
In **Gadgetbridge → Settings → Database → "Export DB"** (or enable **Auto export** to a
path). It writes a SQLite file (e.g. `gadgetbridge`); the bridge reads that file.

## Status
Scaffold: web UI wrapped, debug APK builds. Next: runtime server-URL config + mobile
auth (token), the Gadgetbridge DB reader + mapping, then BLE.
