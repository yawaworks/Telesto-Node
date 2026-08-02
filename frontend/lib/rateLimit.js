import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const registerLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "60 s"),
  prefix: "ratelimit:register",
});

// Keyed by email rather than IP — protects a specific account from
// brute force even if attempts come from many IPs.
export const loginLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "60 s"),
  prefix: "ratelimit:login",
});

export const forgotPasswordLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, "300 s"),
  prefix: "ratelimit:forgot-password",
});

// Keyed by the account's user id — this endpoint checks a password, so it
// needs the same brute-force protection as login.
export const emailChangeLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "300 s"),
  prefix: "ratelimit:email-change",
});

export function getClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}