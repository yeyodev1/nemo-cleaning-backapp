import multer from "multer";
import { CustomError } from "../errors/customError.error";

const ALLOWED = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/;

// memoryStorage: el archivo llega en req.file.buffer y se sube a Cloudinary
// desde el service. En Vercel no hay disco persistente.
export const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.test(file.mimetype)) cb(null, true);
    else cb(new CustomError("Solo se aceptan imágenes (JPG, PNG, WEBP, HEIC) o PDF", 400));
  },
});
