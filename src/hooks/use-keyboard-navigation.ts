import { useEffect, useCallback, useState } from 'react';

interface UseKeyboardNavigationProps<T> {
  items: T[];
  onSelect?: (item: T, index: number) => void;
  enabled?: boolean;
}

/**
 * Hook for keyboard navigation in lists
 * J/K or Arrow keys to navigate, Enter to select
 */
export function useKeyboardNavigation<T>({
  items,
  onSelect,
  enabled = true,
}: UseKeyboardNavigationProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!enabled || items.length === 0) return;

    // Don't handle if focus is on an input/textarea
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
      return;
    }

    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        event.preventDefault();
        setSelectedIndex(prev => {
          const next = prev < items.length - 1 ? prev + 1 : prev;
          return next;
        });
        break;
      case 'k':
      case 'ArrowUp':
        event.preventDefault();
        setSelectedIndex(prev => {
          const next = prev > 0 ? prev - 1 : 0;
          return next;
        });
        break;
      case 'Enter':
        if (selectedIndex >= 0 && selectedIndex < items.length) {
          event.preventDefault();
          onSelect?.(items[selectedIndex], selectedIndex);
        }
        break;
      case 'Escape':
        setSelectedIndex(-1);
        break;
    }
  }, [enabled, items, selectedIndex, onSelect]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(prev => {
      // Try to keep selection valid
      if (prev >= items.length) {
        return items.length - 1;
      }
      return prev;
    });
  }, [items]);

  return {
    selectedIndex,
    setSelectedIndex,
    selectedItem: selectedIndex >= 0 ? items[selectedIndex] : null,
  };
}
