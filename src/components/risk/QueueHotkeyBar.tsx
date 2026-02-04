import { Badge } from "@/components/ui/badge";

interface QueueHotkeyBarProps {
  disabled?: boolean;
  hasItems: boolean;
  selectedLabel?: string | null;
}

export function QueueHotkeyBar({
  disabled,
  hasItems,
  selectedLabel,
}: QueueHotkeyBarProps) {
  if (!hasItems || disabled) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 py-2">
      <div className="flex items-center justify-between max-w-7xl mx-auto">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="font-medium">Hotkeys:</span>
          <span><kbd className="px-1.5 py-0.5 text-xs font-mono bg-muted rounded border">/</kbd> Search</span>
          <span><kbd className="px-1.5 py-0.5 text-xs font-mono bg-muted rounded border">J</kbd>/<kbd className="px-1.5 py-0.5 text-xs font-mono bg-muted rounded border">K</kbd> Navigate</span>
          <span><kbd className="px-1.5 py-0.5 text-xs font-mono bg-muted rounded border">Enter</kbd> Open</span>
          <span><kbd className="px-1.5 py-0.5 text-xs font-mono bg-muted rounded border">Esc</kbd> Clear</span>
        </div>

        {selectedLabel && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Selected:</span>
            <Badge variant="secondary">{selectedLabel}</Badge>
          </div>
        )}
      </div>
    </div>
  );
}
