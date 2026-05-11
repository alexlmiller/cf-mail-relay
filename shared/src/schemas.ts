// zod schemas shared by worker/ and ui/.
// MS2 fills these in to match D1 row shapes and HTTP API contracts.

import { z } from "zod";

export const sendRequestSchema = z.object({
  // TODO MS4: full /send schema (raw MIME path).
  raw: z.string().min(1),
});

export type SendRequest = z.infer<typeof sendRequestSchema>;
