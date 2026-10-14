import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskExport } from '../components/task/TaskExport';
const { inspect, build, state } = vi.hoisted(() => ({ inspect:vi.fn(), build:vi.fn(), state:{activeExecution:null,taskInspection:null} }));
vi.mock('../store/useAppStore',()=>({useAppStore:Object.assign((select:(s:typeof state)=>unknown)=>select(state),{getState:()=>state})}));
vi.mock('../services/agent/runtime/pi/piTaskExports',()=>({inspectTaskExport:inspect,buildTaskExport:build}));
beforeEach(()=>{
    vi.clearAllMocks();inspect.mockReturnValue({available:true,reason:'Actual outputs available.'});
    build.mockResolvedValue({bytes:new Uint8Array([1,2]),fileName:'task.zip'});
    Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=> 'blob:task')});
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});
    vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>undefined);
});
afterEach(cleanup);
describe('explicit user task export',()=>{
    it('downloads a bundle and keeps the completeness and retention disclosures visible',async()=>{
        render(<TaskExport taskId="task"/>);fireEvent.click(screen.getByRole('button',{name:'Export task bundle'}));
        await waitFor(()=>expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce());
        expect(build).toHaveBeenCalledWith(expect.anything(),'task');expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:task');
        expect(screen.getByText(/file existence does not certify facts/)).toBeInTheDocument();
        expect(screen.getByText(/No automatic persistence/)).toBeInTheDocument();
    });
    it('does not infer export custody from a historical completed UI projection',()=>{
        inspect.mockReturnValue({available:false,reason:'task_export_custody_unavailable'});
        render(<TaskExport taskId="task"/>);expect(screen.getByRole('button',{name:'Export task bundle'})).toBeDisabled();
        expect(build).not.toHaveBeenCalled();
    });
    it('rechecks ownership after packaging and withholds a replaced task download',async()=>{
        let resolve!:(value:unknown)=>void;build.mockReturnValue(new Promise(r=>{resolve=r;}));
        render(<TaskExport taskId="task"/>);fireEvent.click(screen.getByRole('button',{name:'Export task bundle'}));
        inspect.mockReturnValue({available:false,reason:'task_export_custody_unavailable'});
        resolve({bytes:new Uint8Array([1]),fileName:'old-task.zip'});
        await screen.findByText('task export custody replaced');expect(URL.createObjectURL).not.toHaveBeenCalled();
    });
});
