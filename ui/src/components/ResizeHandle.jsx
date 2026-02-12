import { useCallback, useRef } from 'react';

function ResizeHandle({ onResize, direction = 'horizontal', onDoubleClick }) {
  const startRef = useRef(0);
  const isDraggingRef = useRef(false);
  const isVertical = direction === 'vertical';

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    startRef.current = isVertical ? e.clientX : e.clientY;
    isDraggingRef.current = true;

    const handleMouseMove = (e) => {
      if (!isDraggingRef.current) return;
      const current = isVertical ? e.clientX : e.clientY;
      const delta = current - startRef.current;
      startRef.current = current;
      onResize(delta);
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [isVertical, onResize]);

  return (
    <div
      className={`resize-handle resize-handle-${direction}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
    />
  );
}

export default ResizeHandle;
