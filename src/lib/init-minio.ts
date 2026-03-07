import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { config } from "../config.js";

export const s3Client = new S3Client({
  endpoint: config.s3Endpoint,
  region: config.s3Region,
  credentials: {
    accessKeyId: config.s3AccessKey,
    secretAccessKey: config.s3SecretKey,
  },
  forcePathStyle: true,
});

export const BUCKET = config.s3Bucket;

let bucketChecked = false;

export async function ensureBucket(): Promise<boolean> {
  if (bucketChecked) return true;
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET }));
    bucketChecked = true;
    return true;
  } catch {
    try {
      await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET }));
      console.log(`Created bucket: ${BUCKET}`);
      bucketChecked = true;
      return true;
    } catch (createError) {
      console.error("Failed to create bucket:", createError);
      return false;
    }
  }
}
