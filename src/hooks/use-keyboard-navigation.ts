import { useEffect, useCallback, useState, RefObject } from 'react';

interface UseKeyboardNavigationProps<T> {
  items: T[];
  onSelect?: (item: T, index: number) => void;
  enabled?: boolean;
  searchInputRef?: RefObject<HTMLInputElement>;
  onSearchClear?: () => void;
  hasSearchText?: boolean;
}

/**
 * Hook for keyboard navigation in lists
 * J/K or Arrow keys to navigate, Enter to select
 * "/" to focus search, Esc to clear search or selection
 */
export function useKeyboardNavigation<T>({
  items,
  onSelect,
  enabled = true,
  searchInputRef,
  onSearchClear,
  hasSearchText = false,
}: UseKeyboardNavigationProps<T>) {
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!enabled) return;

    // Don't handle if focus is on an input/textarea (except for Esc and /)
    const target = event.target as HTMLElement;
    const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    const key = event.key.toLowerCase();

    // "/" focuses search from anywhere (except when already in search)
    if (key === '/' && !isInInput && searchInputRef?.current) {
      event.preventDefault();
      searchInputRef.current.focus();
      return;
    }

    // Esc: clear search if has text, otherwise clear selection, also blur search
    if (key === 'escape') {
      event.preventDefault();
      if (hasSearchText && onSearchClear) {
        onSearchClear();
      } else {
        setSelectedIndex(-1);
      }
      // Blur search input if focused
      if (isInInput && searchInputRef?.current) {
        searchInputRef.current.blur();
      }
      return;
    }

    // Don't handle navigation if in input
    if (isInInput) return;
    if (items.length === 0) return;

    switch (key) {
      case 'j':
      case 'arrowdown':
        event.preventDefault();
        setSelectedIndex(prev => {
          const next = prev < items.length - 1 ? prev + 1 : prev;
          return next;
        });
        break;
      case 'k':
      case 'arrowup':
        event.preventDefault();
        setSelectedIndex(prev => {
          const next = prev > 0 ? prev - 1 : 0;
          return next;
        });
        break;
      case 'enter':
        if (selectedIndex >= 0 && selectedIndex < items.length) {
          event.preventDefault();
          onSelect?.(items[selectedIndex], selectedIndex);
        }
        break;
    }
  }, [enabled, items, selectedIndex, onSelect, searchInputRef, onSearchClear, hasSearchText]);

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
