export function TabError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <span>{message}</span>
      <button onClick={onRetry} className="px-3 py-1 rounded-md border border-red-500/30 hover:bg-red-500/10">Retry</button>
    </div>
  );
}
