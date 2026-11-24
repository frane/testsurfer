self.counter = 41;
self.onmessage = (e) => self.postMessage('worker got ' + e.data);
