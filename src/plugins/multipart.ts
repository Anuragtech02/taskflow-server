import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import multipart from "@fastify/multipart";

async function multipartPlugin(fastify: FastifyInstance) {
  await fastify.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
      files: 5,
    },
  });
}

export default fp(multipartPlugin, { name: "multipart" });
