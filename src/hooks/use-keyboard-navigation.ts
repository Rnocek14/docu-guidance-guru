import { useEffect, useCallback, useState, RefObject } from 'react';

interface UseKeyboardNavigationProps<T> {
  items: T[];
  onSelect?: (item: T, index: number) => void;
  enabled?: boolean;
  searchInputRef?: RefObject<HTMLInputElement>;
  onSearchClear?: () => void;
  hasSearchText?: boolean;
  // External state control for ID-based stability
  externalSelectedIndex?: number;
  onSelectedIndexChange?: (index: number) => void;
}

/**
 * Hook for keyboard navigation in lists
 * J/K or Arrow keys to navigate, Enter to select
 * "/" to focus search, Esc to clear search or selection
 * 
 * Supports external state control via externalSelectedIndex + onSelectedIndexChange
 * for ID-based selection stability across data refetches.
 */
export function useKeyboardNavigation<T>({
  items,
  onSelect,
  enabled = true,
  searchInputRef,
  onSearchClear,
  hasSearchText = false,
  externalSelectedIndex,
  onSelectedIndexChange,
}: UseKeyboardNavigationProps<T>) {
  // Use external state if provided, otherwise internal
  const isExternallyControlled = externalSelectedIndex !== undefined && onSelectedIndexChange !== undefined;
  const [internalIndex, setInternalIndex] = useState<number>(-1);
  
  const selectedIndex = isExternallyControlled ? externalSelectedIndex : internalIndex;
  const setSelectedIndex = isExternallyControlled ? onSelectedIndexChange : setInternalIndex;

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
        {
          const next = selectedIndex < items.length - 1 ? selectedIndex + 1 : selectedIndex;
          setSelectedIndex(next < 0 ? 0 : next);
        }
        break;
      case 'k':
      case 'arrowup':
        event.preventDefault();
        {
          const next = selectedIndex > 0 ? selectedIndex - 1 : 0;
          setSelectedIndex(next);
        }
        break;
      case 'enter':
        if (selectedIndex >= 0 && selectedIndex < items.length) {
          event.preventDefault();
          onSelect?.(items[selectedIndex], selectedIndex);
        }
        break;
    }
  }, [enabled, items, selectedIndex, setSelectedIndex, onSelect, searchInputRef, onSearchClear, hasSearchText]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Reset selection when items change (only for internal state)
  useEffect(() => {
    if (!isExternallyControlled) {
      setInternalIndex(prev => {
        // Try to keep selection valid
        if (prev >= items.length) {
          return items.length - 1;
        }
        return prev;
      });
    }
  }, [items, isExternallyControlled]);

  return {
    selectedIndex,
    setSelectedIndex,
    selectedItem: selectedIndex >= 0 ? items[selectedIndex] : null,
  };
}
