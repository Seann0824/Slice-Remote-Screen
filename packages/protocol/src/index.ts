import { z } from "zod";

export const targetKindSchema = z.enum(["window", "display"]);
export type TargetKind = z.infer<typeof targetKindSchema>;

export const frameSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const remoteTargetSchema = z.object({
  kind: targetKindSchema,
  id: z.number().int().nonnegative(),
  title: z.string(),
  appName: z.string().nullish().transform((value) => value ?? null),
  bundleIdentifier: z.string().nullish().transform((value) => value ?? null),
  frame: frameSchema,
});
export type RemoteTarget = z.infer<typeof remoteTargetSchema>;

export const normalizedRectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).refine((rect) => rect.x + rect.width <= 1.000_001, {
  message: "Rectangle exceeds the right edge",
}).refine((rect) => rect.y + rect.height <= 1.000_001, {
  message: "Rectangle exceeds the bottom edge",
});

export type NormalizedRect = z.infer<typeof normalizedRectSchema>;

export const canvasRectSchema = z.object({
  x: z.number().finite().min(-1_000).max(1_000),
  y: z.number().finite().min(-1_000).max(1_000),
  width: z.number().finite().positive().max(1_000),
  height: z.number().finite().positive().max(1_000),
});
export type CanvasRect = z.infer<typeof canvasRectSchema>;

export const normalizedRegionSchema = normalizedRectSchema.and(z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  layout: canvasRectSchema.optional(),
}));
export type NormalizedRegion = z.infer<typeof normalizedRegionSchema>;

export const appProfileSchema = z.object({
  version: z.literal(1),
  appKey: z.string().min(1),
  appName: z.string().min(1),
  bundleIdentifier: z.string().nullable(),
  regions: z.array(normalizedRegionSchema),
});
export type AppProfile = z.infer<typeof appProfileSchema>;
export const appProfilesSchema = z.record(z.string(), appProfileSchema);

export const permissionsSchema = z.object({
  screenRecording: z.boolean(),
  accessibility: z.boolean(),
});
export type HostPermissions = z.infer<typeof permissionsSchema>;

export const clickRequestSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type ClickRequest = z.infer<typeof clickRequestSchema>;

const pointerPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export const pointerGestureSchema = z.discriminatedUnion("type", [
  pointerPointSchema.extend({
    type: z.literal("click"),
    button: z.enum(["left", "right", "middle"]).default("left"),
  }),
  z.object({
    type: z.literal("drag"),
    button: z.enum(["left", "right", "middle"]).default("left"),
    points: z.array(pointerPointSchema).min(2).max(64),
    durationMs: z.number().int().min(40).max(5_000).default(240),
  }),
  pointerPointSchema.extend({
    type: z.literal("scroll"),
    deltaX: z.number().finite().min(-4_000).max(4_000),
    deltaY: z.number().finite().min(-4_000).max(4_000),
  }),
]);
export type PointerGesture = z.infer<typeof pointerGestureSchema>;

export const installedAppSchema = z.object({
  appKey: z.string().min(1),
  appName: z.string().min(1),
  bundleIdentifier: z.string().nullish().transform((value) => value ?? null),
  path: z.string().min(1),
  isRunning: z.boolean(),
  hasOpenWindow: z.boolean(),
});
export type InstalledApp = z.infer<typeof installedAppSchema>;

export const launchAppRequestSchema = z.object({
  path: z.string().min(1).max(4_096),
});

export const typeRequestSchema = z.object({
  text: z.string().min(1).max(4_096),
});
export type TypeRequest = z.infer<typeof typeRequestSchema>;

export const keyRequestSchema = z.object({
  key: z.enum(["enter", "escape", "tab", "space", "delete", "left", "right", "up", "down"]),
  modifiers: z.array(z.enum(["command", "control", "option", "shift"])).max(4).default([]),
});
export type KeyRequest = z.infer<typeof keyRequestSchema>;

export const apiErrorSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});

export function targetKey(target: Pick<RemoteTarget, "kind" | "id">) {
  return `${target.kind}:${target.id}` as const;
}

export function appKey(target: Pick<RemoteTarget, "appName" | "bundleIdentifier">) {
  return target.bundleIdentifier || target.appName?.trim().toLocaleLowerCase() || "unknown-app";
}

export function mapRegionPoint(
  region: Pick<NormalizedRegion, "x" | "y" | "width" | "height">,
  localX: number,
  localY: number,
) {
  return {
    x: region.x + localX * region.width,
    y: region.y + localY * region.height,
  };
}
