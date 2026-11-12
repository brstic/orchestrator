// node delay-proxy.mjs <listen port> <target host> <target port> <delay ms> [jitter ms]
// A connection that is as far away as the internet makes it: everything that passes, in either direction, arrives
// `delay` (plus up to `jitter`) milliseconds later, in the order it was sent. For the arcade's two-computer trial
// (two-computers.mjs), where the two computers are really a cable apart.
import net from 'node:net';

const [listen, host, port, delay = '25', jitter = '0'] = process.argv.slice(2);
const pass = (from, to) => {
  // In the order it was sent, whatever the timers do: one queue, one hand that empties it when the head is due.
  const queue = [];
  let last = 0;
  let timer = null;
  const drain = () => {
    timer = null;
    while (queue.length && queue[0].due <= Date.now()) {
      const item = queue.shift();
      if (item.chunk) to.writable && to.write(item.chunk);
      else to.end();
    }
    if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].due - Date.now()));
  };
  const put = (chunk) => {
    const due = Math.max(last, Date.now() + Number(delay) + Math.random() * Number(jitter));
    last = due;
    queue.push({ due, chunk });
    if (!timer) timer = setTimeout(drain, Math.max(0, queue[0].due - Date.now()));
  };
  from.on('data', put);
  from.on('end', () => put(null));
  from.on('error', () => to.destroy());
};
net
  .createServer((near) => {
    const far = net.connect(Number(port), host);
    far.on('error', () => near.destroy());
    near.setNoDelay(true);
    far.setNoDelay(true);
    pass(near, far);
    pass(far, near);
  })
  .listen(Number(listen), '127.0.0.1', () => console.log(`delaying 127.0.0.1:${listen} → ${host}:${port} by ${delay} ms (+${jitter})`));
