import { FastifyInstance } from "fastify";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { authenticateRequest } from "../../plugins/auth.js";
import { config } from "../../config.js";
import { ensureBucket } from "../../lib/init-minio.js";
import { randomUUID } from "crypto";

const s3Client = new S3Client({
  endpoint: config.s3Endpoint,
  region: config.s3Region,
  credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
  forcePathStyle: true,
});
const BUCKET = config.s3Bucket;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/tiff"];

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm",
  mov: "video/quicktime", avi: "video/x-msvideo", mkv: "video/x-matroska", pdf: "application/pdf",
};

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

      const ext = key.split(".").pop()?.toLowerCase() || "";
      const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

      return reply
        .header("Content-Type", contentType)
        .header("Cache-Control", "public, max-age=86400")
        .send(buffer);
    } catch (error) {
      console.error("File proxy error:", error);
      return reply.status(500).send({ error: "Failed to fetch file" });
    }
  });
}
