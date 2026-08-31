import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const fieldVariants = cva("flex gap-2", {
  variants: {
    orientation: {
      vertical: "flex-col",
      horizontal: "flex-row items-center",
      responsive: "flex-col @md/field-group:flex-row @md/field-group:items-center",
    },
  },
  defaultVariants: { orientation: "vertical" },
});

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("@container/field-group flex flex-col gap-4", className)} {...props} />;
}
function Field({ className, orientation, ...props }: React.ComponentProps<"div"> & VariantProps<typeof fieldVariants>) {
  return <div role="group" className={cn(fieldVariants({ orientation }), className)} {...props} />;
}
function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-body-sm font-medium text-ink", className)} {...props} />;
}
function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted", className)} {...props} />;
}
export { Field, FieldDescription, FieldGroup, FieldLabel };

