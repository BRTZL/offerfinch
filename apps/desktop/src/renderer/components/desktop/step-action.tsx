import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

/** A step's own primary action, shown in the first run's fixed footer instead of Continue. */
export interface StepAction {
	label: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	/** Shown while it works ("Drafting…"); the button stays where it is. */
	busy?: boolean;
	testId?: string;
	title?: string;
}

type Slot = { set: (action: StepAction | null) => void };
const StepActionSlot = createContext<Slot | null>(null);

/** Holds the current step's action for the footer. */
export function useStepActionSlot() {
	const [action, setAction] = useState<StepAction | null>(null);
	// The same slot for the page's whole life: a new one each render would re-run every step's
	// effect, and each run re-renders the page.
	const slot = useMemo<Slot>(() => ({ set: setAction }), []);
	return { action, slot };
}

export function StepActionProvider({
	slot,
	children,
}: {
	slot: Slot;
	children: ReactNode;
}) {
	return (
		<StepActionSlot.Provider value={slot}>{children}</StepActionSlot.Provider>
	);
}

/**
 * Puts this step's primary action in the footer while it is shown (outside onboarding, with no
 * footer, it returns false and the step shows its own button).
 */
export function useStepAction(action: StepAction | null): boolean {
	const slot = useContext(StepActionSlot);
	// The footer always calls the step's latest handler, whatever state it closed over.
	const latest = useRef(action);
	latest.current = action;
	const key = action
		? `${String(action.label)}|${action.disabled}|${action.busy}|${action.title}`
		: "none";
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-set when what the footer shows changes
	useEffect(() => {
		if (!slot) return;
		slot.set(
			action ? { ...action, onClick: () => latest.current?.onClick() } : null,
		);
	}, [slot, key]);
	useEffect(() => {
		if (!slot) return;
		return () => slot.set(null);
	}, [slot]);
	return slot !== null;
}
