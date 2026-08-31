import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "h-11 w-full rounded-control border border-transparent bg-inset px-3.5 text-base text-ink outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-product placeholder:text-muted hover:bg-selected focus:border-line-strong focus:bg-surface focus:ring-2 focus:ring-ink/8 disabled:cursor-not-allowed disabled:opacity-45",
          className,
        )}
        {...props}
      />
    );
  },
);

