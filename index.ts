import { VercelRequest, VercelResponse } from '@vercel/node';
import app from './server'; // or wherever your Express app is

export default function handler(req: VercelRequest, res: VercelResponse) {
  app(req, res);
}