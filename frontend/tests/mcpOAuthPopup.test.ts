import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishMcpOAuthPopup } from '../utils/mcpOAuthPopup';
afterEach(()=>{vi.restoreAllMocks();Object.defineProperty(window,'opener',{value:null,configurable:true});window.history.replaceState(null,'','/');});
describe('host OAuth popup callback',()=>{
    it('sends only callback fields to exact opener origin and scrubs the URL before app startup',()=>{
        const postMessage=vi.fn(),close=vi.spyOn(window,'close').mockImplementation(()=>{});
        Object.defineProperty(window,'opener',{value:{postMessage},configurable:true});
        window.history.replaceState(null,'','/index.html?state=csv-mcp-toy&code=synthetic-code&iss=https%3A%2F%2Fissuer.example%2F');
        expect(finishMcpOAuthPopup()).toBe(true);expect(window.location.search).toBe('');expect(postMessage).toHaveBeenCalledWith({kind:'csv-mcp-oauth',state:'csv-mcp-toy',code:'synthetic-code',iss:'https://issuer.example/',error:undefined},window.location.origin);expect(close).toHaveBeenCalledOnce();
    });
    it('does not consume a normal app URL or a callback without an opener',()=>{
        window.history.replaceState(null,'','/index.html?code=synthetic-code&state=ordinary-state');expect(finishMcpOAuthPopup()).toBe(false);
        window.history.replaceState(null,'','/index.html?code=synthetic-code&state=csv-mcp-toy');expect(finishMcpOAuthPopup()).toBe(false);
    });
});
