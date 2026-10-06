import { v2 as cloudinary, UploadApiResponse } from "cloudinary";
import { env } from "../config/env";
import { CustomError } from "../errors/customError.error";

let configured = false;

export function isCloudinaryConfigured(): boolean {
  return !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

function ensureConfig() {
  if (configured) return;
  if (!isCloudinaryConfigured()) {
    throw new CustomError("Cloudinary no está configurado en el servidor", 503);
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
  configured = true;
}

const ROOT_FOLDER = "nemo-cleaning";

/**
 * Sube un buffer (multer memoryStorage). resource_type "auto" acepta imágenes y
 * PDF: los comprobantes de transferencia llegan de las dos formas.
 */
export function uploadBuffer(
  buffer: Buffer,
  subfolder = "uploads",
): Promise<{ url: string; publicId: string }> {
  ensureConfig();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: `${ROOT_FOLDER}/${subfolder}`, resource_type: "auto" },
      (error, result?: UploadApiResponse) => {
        if (error || !result) {
          console.error("[cloudinary] falló la subida:", error);
          return reject(new CustomError("No se pudo subir el archivo. Intenta de nuevo", 502));
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

export async function uploadFile(file: Express.Multer.File | undefined, subfolder: string) {
  if (!file?.buffer?.length) throw new CustomError("Adjunta un archivo en el campo 'file'", 400);
  const { url } = await uploadBuffer(file.buffer, subfolder);
  return { url };
}
