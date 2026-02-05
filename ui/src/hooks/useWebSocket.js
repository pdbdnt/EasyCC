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
        onOpen?.();
      };

      ws.onclose = (event) => {
        if (unmountedRef.current) return;
        setReadyState(WebSocket.CLOSED);
        onClose?.(event);

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
        onError?.(error);
      };

      ws.onmessage = (event) => {
        if (unmountedRef.current) return;
        try {
          const data = JSON.parse(event.data);
          onMessage?.(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      setReadyState(WebSocket.CLOSED);
    }
  }, [url, onMessage, onOpen, onClose, onError, autoReconnect]);

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
