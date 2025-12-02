import type { ServerWebSocket } from "bun";
import type { SignedScore, WebSocketMessage } from "../types/score";
import type { Hex } from "viem";

/**
 * WebSocket client data
 */
interface ClientData {
  subscribedPools: Set<string>;
  subscribeAll: boolean;
}

/**
 * Active WebSocket connections
 */
const clients = new Map<ServerWebSocket<ClientData>, ClientData>();

/**
 * WebSocket message handlers
 */
export const websocketHandlers = {
  /**
   * Handle new connection
   */
  open(ws: ServerWebSocket<ClientData>) {
    const clientData: ClientData = {
      subscribedPools: new Set(),
      subscribeAll: false,
    };
    clients.set(ws, clientData);
    ws.data = clientData;

    console.log(`[WebSocket] Client connected. Total: ${clients.size}`);

    // Send welcome message
    ws.send(
      JSON.stringify({
        type: "connected",
        message: "Connected to Viral Score WebSocket",
        commands: ["subscribe", "unsubscribe", "subscribeAll"],
      })
    );
  },

  /**
   * Handle incoming message
   */
  message(ws: ServerWebSocket<ClientData>, message: string | Buffer) {
    try {
      const data = JSON.parse(
        typeof message === "string" ? message : message.toString()
      ) as WebSocketMessage;

      switch (data.type) {
        case "subscribe":
          handleSubscribe(ws, data.poolIds || []);
          break;

        case "unsubscribe":
          handleUnsubscribe(ws, data.poolIds || []);
          break;

        default:
          // Handle subscribeAll
          if ((data as any).type === "subscribeAll") {
            ws.data.subscribeAll = true;
            ws.send(
              JSON.stringify({
                type: "subscribed",
                message: "Subscribed to all score updates",
              })
            );
          } else {
            ws.send(
              JSON.stringify({
                type: "error",
                error: `Unknown message type: ${data.type}`,
              })
            );
          }
      }
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "error",
          error: "Invalid message format. Expected JSON.",
        })
      );
    }
  },

  /**
   * Handle connection close
   */
  close(ws: ServerWebSocket<ClientData>) {
    clients.delete(ws);
    console.log(`[WebSocket] Client disconnected. Total: ${clients.size}`);
  },

  /**
   * Handle errors
   */
  error(ws: ServerWebSocket<ClientData>, error: Error) {
    console.error("[WebSocket] Error:", error);
    clients.delete(ws);
  },
};

/**
 * Handle subscribe request
 */
function handleSubscribe(
  ws: ServerWebSocket<ClientData>,
  poolIds: string[]
): void {
  const clientData = ws.data;

  for (const poolId of poolIds) {
    clientData.subscribedPools.add(poolId.toLowerCase());
  }

  ws.send(
    JSON.stringify({
      type: "subscribed",
      poolIds,
      totalSubscriptions: clientData.subscribedPools.size,
    })
  );

  console.log(
    `[WebSocket] Client subscribed to ${poolIds.length} pools. Total subs: ${clientData.subscribedPools.size}`
  );
}

/**
 * Handle unsubscribe request
 */
function handleUnsubscribe(
  ws: ServerWebSocket<ClientData>,
  poolIds: string[]
): void {
  const clientData = ws.data;

  for (const poolId of poolIds) {
    clientData.subscribedPools.delete(poolId.toLowerCase());
  }

  ws.send(
    JSON.stringify({
      type: "unsubscribed",
      poolIds,
      totalSubscriptions: clientData.subscribedPools.size,
    })
  );
}

/**
 * Broadcast score update to subscribed clients
 */
export function broadcastScoreUpdate(
  poolId: Hex,
  signedScore: SignedScore
): void {
  const poolIdLower = poolId.toLowerCase();
  let sentCount = 0;

  for (const [ws, clientData] of clients) {
    // Send if client is subscribed to this pool or subscribed to all
    if (
      clientData.subscribeAll ||
      clientData.subscribedPools.has(poolIdLower)
    ) {
      try {
        ws.send(
          JSON.stringify({
            type: "scoreUpdate",
            data: {
              poolId: signedScore.poolId,
              score: signedScore.score.toString(),
              timestamp: signedScore.timestamp.toString(),
              nonce: signedScore.nonce.toString(),
              signature: signedScore.signature,
            },
          })
        );
        sentCount++;
      } catch (error) {
        console.error("[WebSocket] Failed to send to client:", error);
      }
    }
  }

  if (sentCount > 0) {
    console.log(
      `[WebSocket] Broadcasted score update for ${poolId.slice(0, 10)}... to ${sentCount} clients`
    );
  }
}

/**
 * Broadcast merkle update to all clients
 */
export function broadcastMerkleUpdate(
  root: Hex,
  epoch: number,
  poolCount: number
): void {
  const message = JSON.stringify({
    type: "merkleUpdate",
    data: {
      root,
      epoch,
      poolCount,
      timestamp: Math.floor(Date.now() / 1000),
    },
  });

  let sentCount = 0;
  for (const [ws] of clients) {
    try {
      ws.send(message);
      sentCount++;
    } catch (error) {
      console.error("[WebSocket] Failed to send merkle update:", error);
    }
  }

  console.log(`[WebSocket] Broadcasted merkle update to ${sentCount} clients`);
}

/**
 * Get WebSocket connection stats
 */
export function getWebSocketStats(): {
  totalConnections: number;
  totalSubscriptions: number;
} {
  let totalSubscriptions = 0;
  for (const [, clientData] of clients) {
    totalSubscriptions += clientData.subscribedPools.size;
    if (clientData.subscribeAll) totalSubscriptions += 1;
  }

  return {
    totalConnections: clients.size,
    totalSubscriptions,
  };
}

/**
 * Broadcast to all connected clients (for announcements)
 */
export function broadcastAll(message: object): void {
  const messageStr = JSON.stringify(message);

  for (const [ws] of clients) {
    try {
      ws.send(messageStr);
    } catch (error) {
      console.error("[WebSocket] Failed to broadcast:", error);
    }
  }
}

