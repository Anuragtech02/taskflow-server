import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import cors from "@fastify/cors";
import { config } from "../config.js";

async function corsPlugin(fastify: FastifyInstance) {
  await fastify.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return cb(null, true);

      const allowedOrigin = config.corsOrigin;
      const mainDomain = config.mainDomain;

      // Allow exact match
      if (origin === allowedOrigin) return cb(null, true);

      // Allow subdomains of mainDomain
      if (mainDomain && origin.endsWith(`.${mainDomain}`)) return cb(null, true);

      // Allow localhost in development
      try {
        const url = new URL(origin);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          return cb(null, true);
        }
      } catch {
        // Invalid origin URL
      }

      cb(new Error("Not allowed by CORS"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    exposedHeaders: ["Content-Disposition"],
  });
}

export default fp(corsPlugin, { name: "cors" });
