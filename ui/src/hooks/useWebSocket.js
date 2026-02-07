import { useState, useEffect, useRef, useCallback } from 'react';

const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

export function useWebSocket(url, options = {}) {
  const { onMessage, onOpen, onClose, onError, autoReconnect = true } = options;

  const [readyState, setReadyState] = useState(WebSocket.CONNECTING);
  const wsRef = useRef(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimeout = useRef(null);
  const unmountedRef = useRef(false);

  // Store callbacks in refs to avoid reconnecting when they change
  const onMessageRef = useRef(onMessage);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  const onErrorRef = useRef(onError);

  // Update refs when callbacks change (without triggering reconnect)
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    try {
      // Build WebSocket URL - use same host (Vite will proxy in dev mode)
      const wsUrl = url.startsWith('ws')
        ? url
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${url}`;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current) {
          ws.close();
          return;
        }
        setReadyState(WebSocket.OPEN);
        reconnectAttempts.current = 0;
        onOpenRef.current?.();
      };

      ws.onclose = (event) => {
        if (unmountedRef.current) return;
        setReadyState(WebSocket.CLOSED);
        onCloseRef.current?.(event);

        // Attempt to reconnect
        if (autoReconnect && reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts.current++;
          reconnectTimeout.current = setTimeout(() => {
            if (!unmountedRef.current) {
              connect();
            }
          }, RECONNECT_DELAY);
        }
      };

      ws.onerror = (error) => {
        if (unmountedRef.current) return;
        onErrorRef.current?.(error);
      };

      ws.onmessage = (event) => {
        if (unmountedRef.current) return;
        try {
          const data = JSON.parse(event.data);
          onMessageRef.current?.(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      setReadyState(WebSocket.CLOSED);
    }
  }, [url, autoReconnect]); // Only reconnect when URL or autoReconnect changes

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message = typeof data === 'string' ? data : JSON.stringify(data);
      wsRef.current.send(message);
      return true;
    }
    return false;
  }, []);

  const close = useCallback(() => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  return {
    send,
    close,
    readyState,
    isConnected: readyState === WebSocket.OPEN
  };
}

export default useWebSocket;
