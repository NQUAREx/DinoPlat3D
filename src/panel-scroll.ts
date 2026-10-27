/** Local manual/editor scrolling while native page gestures remain disabled. */
export function panelScroll(root: HTMLElement, signal: AbortSignal) {
  let pointer = -1,
    y = 0,
    scroll = 0;
  let target = root;
  root.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.pointerType !== "touch" ||
        (event.target as Element).closest("button,input,a,summary")
      )
        return;
      pointer = event.pointerId;
      target = (event.target as Element).closest<HTMLElement>(".online-table-scroll") ?? root;
      y = event.clientY;
      scroll = target.scrollTop;
      event.preventDefault();
      root.setPointerCapture(pointer);
    },
    { signal },
  );
  root.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerId === pointer)
        target.scrollTop = scroll + y - event.clientY;
    },
    { signal },
  );
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
    root.addEventListener(
      type,
      () => {
        pointer = -1;
      },
      { signal },
    );
}
