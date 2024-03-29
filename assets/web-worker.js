self.addEventListener('message', (e) => {
    console.dir(e.data);
    const superBuffer = new Blob(e.data, {type: 'video/webm'});
    const objectURL = URL.createObjectURL(superBuffer);

    self.postMessage(objectURL);
}, false);
