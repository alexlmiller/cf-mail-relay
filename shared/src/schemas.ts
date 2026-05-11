// zod schemas shared by worker/ and ui/.

import { z } from "zod";

export const sendRequestSchema = z.object({
  raw: z.string().min(1).regex(/^[A-Za-z0-9+/_=-]+$/, "raw must be base64-encoded MIME"),
});

export type SendRequest = z.infer<typeof sendRequestSchema>;
