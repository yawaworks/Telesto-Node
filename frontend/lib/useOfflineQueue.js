import Script from "next/script";
import "./globals.css";
import Providers from "./providers";
import ServiceWorkerRegister from "../components/ServiceWorkerRegister";

export const metadata = {
  title: "Telesto Node — Mission Control",
  description: "Real-Time Marine Ecosystem Monitoring & Health Analytics",
  manifest: "/manifest.json",
};

export const viewport = {
  themeColor: "#171d20",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css"
          rel="stylesheet"
        />
      </head>
      <body className="font-mono">
        <Script
          src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"
          strategy="beforeInteractive"
        />
        {/* Cloudflare Turnstile — loaded globally (not per-page) since it's
            used on login, signup, and forgot-password. `render=explicit`
            means pages call window.turnstile.render(...) themselves
            instead of it auto-rendering every div with the widget class —
            needed because those forms mount/unmount conditionally. */}
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
          strategy="afterInteractive"
        />
        <ServiceWorkerRegister />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}