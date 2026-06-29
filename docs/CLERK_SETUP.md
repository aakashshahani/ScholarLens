# Clerk auth — setup & migration

ScholarLens supports two auth providers, chosen by the `AUTH_PROVIDER` env var:

- `password` (default) — built-in bcrypt + server sessions. Unchanged, still works.
- `clerk` — verify a Clerk session JWT and resolve it to the internal user.

The backend is already implemented and **env-gated**: with `AUTH_PROVIDER` unset
or `password`, none of the Clerk code runs. Flip to `clerk` only after the steps
below. You can roll back instantly by setting it back to `password`.

---

## First: Clerk vs the Fernet key (your question)

They solve **different problems** and Clerk does not replace Fernet:

| | What it is | What it protects |
|---|---|---|
| **Clerk** | Authentication — *who is logging in* | Login: email+password, **passkeys**, **email/SMS passcodes (OTP)**, OAuth |
| **Fernet key** | Symmetric encryption key on the server | Encrypts each user's **BYOK Anthropic API key** at rest in Postgres |

So: **keep `FERNET_KEY`.** It encrypts the Anthropic keys users paste into
Settings — Clerk never sees or stores those. The only way to drop Fernet is to
drop the BYOK feature (or move secrets to a managed KMS), which is unrelated to
auth.

**Passkeys / passcodes:** yes, you can absolutely use them — they're *login
methods*, toggled in the Clerk dashboard (Email → enable "Email verification
code", and enable "Passkeys"). No code change. They replace the password, not
the Fernet key.

---

## What the migration does to your data

Everything you own is keyed to the internal `users.id` (a UUID) — verified
against the schema: `papers.user_id REFERENCES users(id)`, and every query is
`WHERE user_id = <internal id>`. Email is just a login/display column.

So linking Clerk to your existing row (or changing its email) keeps `users.id`
unchanged → **all 12 papers stay attached.** The server resolves identity in this
order, clerk-id first so a wrong email can never fork your data:

1. row already linked to this `clerk_user_id` → use it
2. row with this email → link the clerk id onto it (preserves the library)
3. neither → create a fresh Clerk-backed row

---

## 1. Clerk dashboard

1. Create an application at https://dashboard.clerk.com.
2. **User & Authentication → Email, Phone, Username**: enable Email; turn on
   "Email verification code" (passcodes) and/or "Passkeys" as you like.
3. **JWT templates** (recommended): create/edit the session token so it includes
   an `email` claim:
   ```json
   { "email": "{{user.primary_email_address}}" }
   ```
   This lets the backend link-by-email without a Backend API round-trip. (If you
   skip it, set `CLERK_SECRET_KEY` and the server fetches the email by user id.)
4. Note these from **API keys**:
   - Publishable key (`pk_...`) → frontend
   - Secret key (`sk_...`) → backend (optional, only for the email fallback)
   - Your Frontend API URL, e.g. `https://your-app.clerk.accounts.dev`

---

## 2. Backend env vars (Render)

```
AUTH_PROVIDER=clerk
CLERK_ISSUER=https://your-app.clerk.accounts.dev
CLERK_JWKS_URL=https://your-app.clerk.accounts.dev/.well-known/jwks.json
CLERK_SECRET_KEY=sk_...        # optional: only used when the JWT lacks an email claim
```

`PyJWT` is already in `requirements.txt`. Keep `FERNET_KEY` set.

---

## 3. Migrate your existing account (the 12 papers)

Pick one, run it on the server (or anywhere with `DATABASE_URL` set):

**A — fix the email, then sign in with Clerk using that same email:**
```bash
python -m jobs.link_account --from aakash@example.com --to you@real-email.com
```
Then create your Clerk account with `you@real-email.com`; first sign-in links
automatically.

**B — link directly by Clerk id (works even if emails differ):**
Create your Clerk account, copy your user id (`user_...`) from the dashboard:
```bash
python -m jobs.link_account --email aakash@example.com --clerk-id user_xxx
```

Either way your papers are preserved (both edit the same `users.id` row).

---

## 4. Frontend wiring

```bash
cd frontend
npm install @clerk/nextjs
```

`.env.local`:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
NEXT_PUBLIC_AUTH_PROVIDER=clerk
```

**`src/middleware.ts`:**
```ts
import { clerkMiddleware } from "@clerk/nextjs/server";
export default clerkMiddleware();
export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
```

**Wrap the app** — in `src/app/layout.tsx`, wrap `<body>`'s children in
`<ClerkProvider>` (import from `@clerk/nextjs`).

**Token bridge** — a client component that pushes Clerk's session token into the
existing API client (mount it once inside `<ClerkProvider>`):
```tsx
"use client";
import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";
import { setAuthTokenGetter } from "@/lib/api";
export function ClerkTokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => { setAuthTokenGetter(() => getToken()); return () => setAuthTokenGetter(null); }, [getToken]);
  return null;
}
```

**Matched sign-in screen** — `src/components/auth-gate-clerk.tsx`. Reuses your
existing `GateBackdrop`/logo and themes Clerk with your exact palette so it looks
native (not a default Clerk card):

```tsx
"use client";
import { SignIn } from "@clerk/nextjs";
import { LogoBadge } from "@/components/logo";

// Same palette as globals.css so Clerk matches the rest of the app.
const appearance = {
  variables: {
    colorPrimary: "#7C6FFF",          // --gen
    colorBackground: "#171B24",       // --surface-2
    colorText: "#E8EAED",             // --text-1
    colorTextSecondary: "#9BA1AD",    // --text-2
    colorInputBackground: "#12151C",  // --surface-1
    colorInputText: "#E8EAED",
    colorDanger: "#FF5C5C",           // --contra
    colorSuccess: "#3DD4A0",          // --support
    colorWarning: "#F5A623",          // --nuance
    borderRadius: "9px",              // --r-md
  },
  elements: {
    rootBox: "w-full",
    card: "bg-[#171B24] border border-[rgba(255,255,255,0.10)] shadow-[0_30px_80px_-40px_rgba(0,0,0,0.8)]",
    headerTitle: "text-[#E8EAED]",
    headerSubtitle: "text-[#9BA1AD]",
    socialButtonsBlockButton: "border-[rgba(255,255,255,0.10)] text-[#E8EAED]",
    formFieldInput: "bg-[#12151C] border-[rgba(255,255,255,0.10)] text-[#E8EAED]",
    formButtonPrimary: "bg-[#7C6FFF] hover:opacity-90 text-white",
    footerActionLink: "text-[#7C6FFF]",
    footer: "hidden",                 // Clerk's own footer; optional
  },
};

export function ClerkAuthGate() {
  // GateBackdrop lives in auth-gate.tsx — export it from there and import here,
  // or paste the same canvas component. This keeps the animated claim-field.
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 bg-[var(--canvas)] overflow-hidden">
      <div className="relative z-10 flex items-center gap-3 mb-8">
        <LogoBadge size={32} />
        <span className="font-display text-[20px] text-[var(--text-1)]">ScholarLens</span>
      </div>
      <SignIn appearance={appearance} />
    </div>
  );
}
```

Then, where the app currently renders `<AuthGate />` (the auth boundary that
gates the shell), branch on the provider:
```tsx
{process.env.NEXT_PUBLIC_AUTH_PROVIDER === "clerk"
  ? (<><SignedOut><ClerkAuthGate /></SignedOut><SignedIn>{children}</SignedIn></>)
  : (/* existing password AuthGate flow */)}
```
(`SignedIn` / `SignedOut` are from `@clerk/nextjs`.) Settings' "Sign out" should
call Clerk's `useClerk().signOut()` in clerk mode.

---

## 5. Rollback

Set `AUTH_PROVIDER=password` on the backend and
`NEXT_PUBLIC_AUTH_PROVIDER=password` on the frontend. The Clerk code goes
dormant; bcrypt sessions resume. No data changes.

---

## Why this is split into a doc, not committed live

`@clerk/nextjs` isn't installed in the repo, so committing the Clerk frontend
files would break `npm run build` until you install the SDK and set the keys.
The backend (verification, linking, migration) **is** committed and dormant until
`AUTH_PROVIDER=clerk`. Drop the two components above in after `npm install`.
