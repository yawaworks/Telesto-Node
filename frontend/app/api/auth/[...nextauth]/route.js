import NextAuth from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import bcrypt from "bcryptjs";
import clientPromise from "../../../../lib/mongodb";
import { loginLimiter } from "../../../../lib/rateLimit";

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
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email.trim().toLowerCase();

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

        return { id: user._id.toString(), email: user.email, name: user.name || user.email };
      },
    }),
  ],
  session: {
    strategy: "jwt", // needed since Credentials provider doesn't work with database sessions
  },
  pages: {
    signIn: "/login",
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