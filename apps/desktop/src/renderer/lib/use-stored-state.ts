import { useEffect, useState } from "react";

/** Keeps a value in localStorage (the inspector's open state). */
export function useStoredState<T>(
	key: string,
	initial: T,
): [T, (value: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const raw = localStorage.getItem(key);
			return raw === null ? initial : (JSON.parse(raw) as T);
		} catch {
			return initial;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch {}
	}, [key, value]);
	return [value, setValue];
}
