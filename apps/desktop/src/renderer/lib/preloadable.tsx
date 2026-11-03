import { type ComponentType, lazy } from "react";

/**
 * A code-split component that renders straight away once its chunk has loaded. React.lazy
 * suspends on every first render, even when the chunk is already in memory, and React 19 holds
 * a suspended reveal for about 300 ms: each first visit to a screen waited that long with
 * nothing to fetch. Here lazy() only stands in until `preload()` (called at idle) resolves.
 */
export function preloadable<P extends object>(
	load: () => Promise<ComponentType<P>>,
): ComponentType<P> & { preload: () => Promise<ComponentType<P>> } {
	let loaded: ComponentType<P> | null = null;
	let pending: Promise<ComponentType<P>> | null = null;
	const preload = () => {
		pending ??= load().then((component) => {
			loaded = component;
			return component;
		});
		return pending;
	};
	const Lazy = lazy(() =>
		preload().then((component) => ({ default: component })),
	);
	function Preloadable(props: P) {
		const Loaded = loaded;
		return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
	}
	return Object.assign(Preloadable, { preload });
}
