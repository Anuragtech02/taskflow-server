import { FastifyInstance } from "fastify";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { authenticateRequest } from "../../plugins/auth.js";
import { config } from "../../config.js";
import { ensureBucket } from "../../lib/init-minio.js";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { contentDisposition, SANDBOX_CSP, servePolicy } from "../../lib/file-serving.js";

const s3Client = new S3Client({
  endpoint: config.s3Endpoint,
  region: config.s3Region,
  credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
  forcePathStyle: true,
});
const BUCKET = config.s3Bucket;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/tiff"];


let initialized = false;

export default async function fileRoutes(fastify: FastifyInstance) {
  // POST /upload
  fastify.post("/upload", async (request, reply) => {
    if (!initialized) { await ensureBucket(); initialized = true; }
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const data = await request.file();
      if (!data) return reply.status(400).send({ error: "No file provided" });

      if (!IMAGE_TYPES.includes(data.mimetype)) {
        return reply.status(400).send({ error: "Invalid file type. Only images are allowed." });
      }

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) { chunks.push(chunk); }
      const buffer = Buffer.concat(chunks);
      if (buffer.length > 10 * 1024 * 1024) return reply.status(400).send({ error: "File too large. Max 10MB allowed." });

      const ext = (data.filename.split(".").pop() || "png").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
      const key = `uploads/${authResult.userId}/${randomUUID()}.${ext}`;

      await s3Client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: data.mimetype }));
      return { url: `/files/${key}`, filename: `${randomUUID()}.${ext}` };
    } catch (error) {
      console.error("Upload error:", error);
      return reply.status(500).send({ error: "Failed to upload file" });
    }
  });

  // GET /files/*
  fastify.get("/files/*", async (request, reply) => {
    if (!initialized) { await ensureBucket(); initialized = true; }
    const authResult = await authenticateRequest(request);
    if (!authResult) return reply.status(401).send({ error: "Unauthorized" });
    try {
      const key = (request.params as { "*": string })["*"];

      // Validate key to prevent path traversal
      if (!key || key.includes("..") || !key.startsWith("uploads/") && !key.startsWith("attachments/")) {
        return reply.status(400).send({ error: "Invalid file path" });
      }

      try {
        await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      } catch (headError: any) {
        if (headError?.name === "NotFound" || headError?.$metadata?.httpStatusCode === 404) {
          return reply.status(404).send({ error: "File not found" });
        }
      }

      const response = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      if (!response.Body) return reply.status(404).send({ error: "File not found" });

      const chunks: Uint8Array[] = [];
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) { chunks.push(chunk); }
      const buffer = Buffer.concat(chunks);

      // Attachments keep their original name on download; editor uploads
      // don't have one, so they fall back to the key's basename.
      let filename = key.split("/").pop() || "file";
      if (key.startsWith("attachments/")) {
        const att = await db.query.taskAttachments.findFirst({
          where: eq(schema.taskAttachments.fileKey, key),
          columns: { filename: true },
        });
        if (att?.filename) filename = att.filename;
      }

      const policy = servePolicy(key);
      reply
        .header("Content-Type", policy.contentType)
        .header("Content-Disposition", contentDisposition(policy.inline, filename))
        .header("X-Content-Type-Options", "nosniff")
        // private: these are auth-gated. "public" let a shared cache (the
        // Cloudflare edge in front of the API) store them and serve them to
        // requests that never passed the auth check above.
        .header("Cache-Control", "private, max-age=86400");
      if (policy.sandbox) reply.header("Content-Security-Policy", SANDBOX_CSP);
      return reply.send(buffer);
    } catch (error) {
      console.error("File proxy error:", error);
      return reply.status(500).send({ error: "Failed to fetch file" });
    }
  });
}
