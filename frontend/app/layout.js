import Script from "next/script";
import "./globals.css";
import Providers from "./providers";

export const metadata = {
  title: "Telesto Node — Mission Control",
  description: "Real-Time Marine Ecosystem Monitoring & Health Analytics",
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}