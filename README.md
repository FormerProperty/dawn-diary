# Diary

A simple diary for Dawn's and Tanya's Android phones. You can speak or type to it, it reads answers out loud, and it sends reminders.

- **Speak or type:** "Physio Thursday at 11", "What have I got next week?", "Move the dentist to Friday", "Cancel lunch with Amanda".
- **Always checks first:** nothing is saved, changed or removed until someone taps Yes. Removals can be undone.
- **Answers come from the diary itself.** The AI only works out what was meant. It never makes up entries.
- **Reminders:** a morning list of today's things, an evening reminder if there's something tomorrow, and a nudge about an hour before anything with a time. Each phone sets its own.
- **Shows who did what:** each entry says "Added by Tanya" or similar, and Settings lists recent changes.
- **Easy on the eyes:** large text (with Large and Extra large options), big buttons, plain dates like "Tomorrow, Thursday 26 November".
- **Long-press the app icon** for shortcuts: Say something, What's on today, What's on tomorrow.

## How it's built

- One Cloudflare Worker (`src/`) serves the app (`public/`) and its API.
- A Cloudflare D1 database stores the diary. Its tables are created automatically the first time the app runs.
- A timer runs every 5 minutes to send any reminders that are due.
- Claude Haiku turns speech or text into an instruction (`src/ai.js`).
- Speech recognition and read-aloud use Chrome's built-in features on the phone.

Privacy: in Chrome, the speech audio goes to Google to be turned into text, and that text goes to Anthropic to be understood. Reminders are sent with no content in them. The phone fetches the details from the app itself, so diary details never go through Google's push service.

## Setting it up (about 20 minutes, once)

### 1. Cloudflare account
Sign in at https://dash.cloudflare.com (or create a free account).

### 2. Create the database
1. Go to **Storage & Databases > D1 SQL Database > Create**.
2. Name it `dawn-diary` and create it.
3. Copy the **Database ID** it shows.
4. In GitHub, open `wrangler.toml`, click the pencil icon, and replace the `00000000-…` value of `database_id` with your ID. Commit the change. (Or send me the ID and I'll do it.)

### 3. Deploy from GitHub
1. Go to **Workers & Pages > Create > Import a repository**.
2. Connect GitHub if asked, then choose `FormerProperty/dawn-diary`.
3. Leave the build command empty. The deploy command should be `npx wrangler deploy`.
4. Deploy. From then on, every change pushed to GitHub deploys automatically.

### 4. Add the two secrets
In the new Worker, go to **Settings > Variables and Secrets > Add**. Choose type **Secret** for both:
- `APP_PASSPHRASE`: the passphrase you'll use to sign in on your phone. Make it long, for example four random words.
- `ANTHROPIC_API_KEY`: your key from https://console.anthropic.com.

### 5. Add the web address
In the Worker, go to **Settings > Domains & Routes > Add > Custom domain** and enter `diary.fletcher-park.co.uk`.
This only works if `fletcher-park.co.uk` is managed in your Cloudflare account. If it's managed somewhere else, the app is still available on its `….workers.dev` address in the meantime.

### 6. Your phone
1. Open https://diary.fletcher-park.co.uk in **Chrome** and sign in with the passphrase.
2. Open Chrome's menu (three dots) and choose **Add to home screen** or **Install app**.
3. Open the app from the home screen, go to Settings (the cog) and tap **Turn on reminders**. Then tap **Send a test reminder**.

### 7. Dawn's phone
1. On your phone, go to **Settings > Make a link** and share it to Dawn's phone (WhatsApp, text or email).
2. On her phone, open the link in **Chrome**. It signs her in and shows a short welcome.
3. Tap **Turn on reminders**, then install it to her home screen as in step 6.
4. The link works once, within 48 hours. If it's used up, make another one.

### Android tips
- If reminders stop arriving, check **Phone Settings > Apps > Chrome > Notifications** are on, and that **Battery** is set to *Unrestricted* or *Optimised* (not *Restricted*) for Chrome.
- The first time you tap the microphone, allow microphone access.

## Running it on a computer (for development)

```
npm install
cp .dev.vars.example .dev.vars   # then edit
npx wrangler dev --test-scheduled
```

With `AI_MOCK=1` in `.dev.vars`, typed JSON stands in for the AI, so you can test without an API key. Visit `/__scheduled` to run the reminder timer once.

## Settings in `wrangler.toml`
- `OWNER_NAME`, `PARTNER_NAME`: the names shown in the app.
- `AI_MODEL`: the Claude model used for understanding speech.
- The reminder times are set on each phone in Settings.
