import { z } from 'zod';

export const sideSchema = z.enum(['BUY', 'SELL']);
export const orderTypeSchema = z.enum(['LIMIT', 'MARKET', 'STOP_MARKET', 'STOP_LIMIT']);
export const tifSchema = z.enum(['GTC', 'IOC', 'FOK']);

const positiveInt = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Order entry, as sent by the web client. Prices are paise, qty is units. */
export const placeOrderSchema = z
  .object({
    symbol: z.string().min(1).max(32),
    side: sideSchema,
    type: orderTypeSchema,
    /** Defaults: GTC for limit/stop orders, IOC for market orders. */
    tif: tifSchema.optional(),
    qty: positiveInt,
    price: positiveInt.optional(),
    stopPrice: positiveInt.optional(),
    clientOrderId: z.string().min(1).max(64).optional(),
    competitionId: z.number().int().positive().optional(),
    /** Optional exit plan; the Trade Coach checks whether the trader followed it. */
    planStopPrice: positiveInt.optional(),
    planTargetPrice: positiveInt.optional(),
  })
  .superRefine((o, ctx) => {
    if ((o.type === 'LIMIT' || o.type === 'STOP_LIMIT') && o.price === undefined)
      ctx.addIssue({ code: 'custom', path: ['price'], message: 'price is required for limit orders' });
    if ((o.type === 'MARKET' || o.type === 'STOP_MARKET') && o.price !== undefined)
      ctx.addIssue({ code: 'custom', path: ['price'], message: 'market orders take no price' });
    if ((o.type === 'STOP_MARKET' || o.type === 'STOP_LIMIT') && o.stopPrice === undefined)
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'stopPrice is required for stop orders' });
    if ((o.type === 'LIMIT' || o.type === 'MARKET') && o.stopPrice !== undefined)
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'stopPrice only applies to stop orders' });
    if (o.type === 'MARKET' && o.tif === 'GTC')
      ctx.addIssue({ code: 'custom', path: ['tif'], message: 'market orders must be IOC or FOK' });
  });
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

export const amendOrderSchema = z
  .object({ qty: positiveInt.optional(), price: positiveInt.optional() })
  .refine((v) => v.qty !== undefined || v.price !== undefined, 'nothing to amend');

export const registerSchema = z.object({
  email: z.string().email().max(200),
  password: z
    .string()
    .min(8)
    .max(100)
    .regex(/[A-Za-z]/, 'needs a letter')
    .regex(/[0-9]/, 'needs a digit'),
  displayName: z.string().min(2).max(40),
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(100) });
