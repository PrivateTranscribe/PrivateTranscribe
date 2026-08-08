export interface ToastIdentity {
  title?: string;
  description?: string;
  variant?: "default" | "destructive" | "success";
}

export interface DeduplicatedToast extends ToastIdentity {
  id: string;
  dedupeKey: string;
}

export function getToastDedupeKey(toast: ToastIdentity): string {
  return JSON.stringify([toast.variant ?? "default", toast.title ?? "", toast.description ?? ""]);
}

export function upsertToast<T extends DeduplicatedToast>(
  toasts: T[],
  incomingToast: T
): { toasts: T[]; id: string; replaced: boolean } {
  const existingIndex = toasts.findIndex((toast) => toast.dedupeKey === incomingToast.dedupeKey);

  if (existingIndex === -1) {
    return {
      toasts: [...toasts, incomingToast],
      id: incomingToast.id,
      replaced: false,
    };
  }

  const existingToast = toasts[existingIndex];
  const replacement = {
    ...incomingToast,
    id: existingToast.id,
  };
  const nextToasts = [...toasts];
  nextToasts[existingIndex] = replacement;

  return {
    toasts: nextToasts,
    id: existingToast.id,
    replaced: true,
  };
}
