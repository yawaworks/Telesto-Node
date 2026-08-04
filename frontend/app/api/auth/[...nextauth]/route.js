import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import bcrypt from "bcryptjs";
import clientPromise from "../../../../lib/mongodb";
import { loginLimiter } from "../../../../lib/rateLimit";
import { verifyTurnstile } from "../../../../lib/turnstile";
import { verifyTotpToken, findMatchingBackupCodeIndex } from "../../../../lib/twoFactor";

// Used to keep authorize() constant-time when no user is found,
// so response time doesn't reveal whether an email is registered.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 12);

export const authOptions = {
  adapter: MongoDBAdapter(clientPromise),
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Without this, a Google sign-in for an email that already has a
      // credentials account throws an OAuthAccountNotLinked error (or,
      // worse, creates a second user doc if there's no unique index).
      // Safe here because Google has already verified the email address.
      allowDangerousEmailAccountLinking: true,
    }),
    CredentialsProvider({
      name: "Email and Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        turnstileToken: { label: "Turnstile Token", type: "text" },
        totp: { label: "Two-Factor Code", type: "text" },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email.trim().toLowerCase();

        // Captcha checked first and cheaply, before any rate-limit
        // bucket or database work — a bot flood should get rejected as
        // early as possible.
        const remoteIp = req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim();
        const captchaOk = await verifyTurnstile(credentials.turnstileToken, remoteIp);
        if (!captchaOk) return null;

        const { success } = await loginLimiter.limit(email);
        if (!success) return null; // treated same as invalid credentials — avoids revealing why

        const client = await clientPromise;
        const users = client.db().collection("users");
        const user = await users.findOne({ email });

        if (!user || !user.hashedPassword) {
          // Run a dummy compare so this branch takes roughly the same
          // time as the real one below — prevents timing-based user
          // enumeration on login.
          await bcrypt.compare(credentials.password, DUMMY_HASH);
          return null;
        }

        const isValid = await bcrypt.compare(credentials.password, user.hashedPassword);
        if (!isValid) return null;

        // Password is correct — now check 2FA if it's enabled on this
        // account. Throwing a specific Error here (rather than just
        // returning null) lets the login page distinguish "wrong
        // password" from "right password, now enter your code" via
        // result.error, since NextAuth's signIn() surfaces thrown
        // messages as that field.
        if (user.twoFactorEnabled) {
          if (!credentials.totp) {
            throw new Error("2FA_REQUIRED");
          }

          let totpValid = verifyTotpToken(user.twoFactorSecret, credentials.totp);

          // A backup code is a one-time-use fallback for "I lost my
          // authenticator app" — check it only if the primary TOTP check
          // failed, and consume it (remove from the stored hash list) the
          // moment it's used successfully.
          if (!totpValid && Array.isArray(user.twoFactorBackupCodes)) {
            const idx = await findMatchingBackupCodeIndex(credentials.totp, user.twoFactorBackupCodes);
            if (idx !== -1) {
              totpValid = true;
              const remainingCodes = [...user.twoFactorBackupCodes];
              remainingCodes.splice(idx, 1);
              await users.updateOne(
                { _id: user._id },
                { $set: { twoFactorBackupCodes: remainingCodes } }
              );
            }
          }

          if (!totpValid) {
            throw new Error("Invalid two-factor code");
          }
        }

        return { id: user._id.toString(), email: user.email, name: user.name || user.email };
      },
    }),
  ],
  session: {
    strategy: "jwt", // needed since Credentials provider doesn't work with database sessions
  },
  pages: {
    signIn: "/login",
    // NextAuth's adapter fires this only the first time a user record is
    // created — i.e. a brand-new Google sign-in. Credentials signups are
    // handled separately in the login page itself, since that flow
    // doesn't go through the adapter's createUser path.
    newUser: "/onboarding",
  },
  callbacks: {
    async jwt({ token, trigger, session }) {
      // Lets the client call useSession().update({ email }) right after a
      // successful email change, so the new email shows up everywhere that
      // reads session.user.email without forcing a sign-out/sign-in.
      if (trigger === "update" && session?.email) {
        token.email = session.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };