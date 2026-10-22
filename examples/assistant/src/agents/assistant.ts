'use agent';
import { useModel, useSandbox } from '@flue/runtime';
import { workspace } from '../cloudflare.ts';

export function Assistant() {
	useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
	// One sandbox per agent instance (the sandbox id defaults to the instance
	// id).
	useSandbox(workspace);
	return 'You complete task requests submitted directly to this agent.';
}
