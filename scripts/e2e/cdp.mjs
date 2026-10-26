// 一个最小 CDP 客户端：能发命令，也能收事件。
//
// harness.mjs 的 connect() 只支持"发命令等回答"，抓不到 Network 事件；而
// 评论 RPC 的请求形状（方法/头/body）只能在事件里看。单独抽一个模块，两个
// 尖峰脚本共用（注意：import 这个模块不会执行任何探针逻辑）。
export function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let nextId = 0;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('cdp websocket failed'));
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, events, close: () => ws.close() };
}

