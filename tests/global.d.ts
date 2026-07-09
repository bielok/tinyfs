import type * as TinyFSModule from "../src/tinyfs";

declare global
{
    interface Window
    {
        tinyfs      : typeof TinyFSModule;
        tfs         : InstanceType<typeof TinyFSModule.TinyFS>;
        __tests     : Record<string, (...args : any[]) => any>;
        __atomicity : {
            tests       : Record<string, (...args : any[]) => any>;
            abortAfter  (n : number) : void;
            reset       () : void;
        };
    }
}
