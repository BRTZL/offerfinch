import type { AnchorHTMLAttributes, ReactNode } from "react";
import {
	useLocation,
	useSearch,
	useParams as useWouterParams,
	Link as WouterLink,
} from "wouter";

export function Link({
	href,
	children,
	...rest
}: { href: string; children?: ReactNode } & Omit<
	AnchorHTMLAttributes<HTMLAnchorElement>,
	"href"
>) {
	return (
		<WouterLink href={href} {...rest}>
			{children}
		</WouterLink>
	);
}

export function usePathname(): string {
	return useLocation()[0];
}

export function useSearchParams(): URLSearchParams {
	return new URLSearchParams(useSearch());
}

export function useParams<T extends Record<string, string>>(): T {
	return useWouterParams() as T;
}

export function useRouter() {
	const [, navigate] = useLocation();
	return {
		push: (to: string) => navigate(to),
		replace: (to: string) => navigate(to, { replace: true }),
		back: () => window.history.back(),
		refresh: () => {},
		prefetch: () => {},
	};
}
