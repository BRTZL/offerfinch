"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A sheet for a short form (add or edit one record): the alert dialog's frame, wider. */
function Dialog({ ...props }: DialogPrimitive.Root.Props) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent({ className, ...props }: DialogPrimitive.Popup.Props) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Backdrop
				data-slot="dialog-overlay"
				className="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 bg-scrim fixed inset-0 isolate z-50 duration-200"
			/>
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				className={cn(
					"border-border bg-popover text-popover-foreground ease-standard data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-2xl border p-6 shadow-[var(--shadow-popup)] duration-200 outline-none",
					className,
				)}
				{...props}
			/>
		</DialogPrimitive.Portal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("grid gap-1 text-left", className)}
			{...props}
		/>
	);
}

function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-body"
			className={cn("-mx-6 min-h-0 flex-1 overflow-auto px-6", className)}
			{...props}
		/>
	);
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn("flex items-center justify-end gap-2", className)}
			{...props}
		/>
	);
}

function DialogTitle({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("text-base font-semibold", className)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn("text-muted-foreground text-sm", className)}
			{...props}
		/>
	);
}

function DialogClose({
	variant = "outline",
	...props
}: DialogPrimitive.Close.Props &
	Pick<React.ComponentProps<typeof Button>, "variant">) {
	return (
		<DialogPrimitive.Close
			data-slot="dialog-close"
			render={<Button variant={variant} />}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
};
