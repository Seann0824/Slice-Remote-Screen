import { type ComponentProps } from "react";
import { cn } from "../lib/utils";

function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("animate-pulse-soft rounded-control bg-shimmer", className)} {...props} />;
}
export { Skeleton };

