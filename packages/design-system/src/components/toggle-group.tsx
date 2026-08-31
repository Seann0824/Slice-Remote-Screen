import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cn } from "../lib/utils";

export const ToggleGroup = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(function ToggleGroup({ className, ...props }, ref) {
  return <ToggleGroupPrimitive.Root ref={ref} className={cn("flex gap-2", className)} {...props} />;
});

export const ToggleGroupItem = forwardRef<
  ElementRef<typeof ToggleGroupPrimitive.Item>,
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(function ToggleGroupItem({ className, ...props }, ref) {
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border-0 bg-inset px-4 text-body-sm text-ink outline-none transition-colors duration-150 ease-product hover:bg-selected focus-visible:ring-2 focus-visible:ring-ink/35 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
});

