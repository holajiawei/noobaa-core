import template from './diagnostics-form.html';
import Disposable from 'disposable';
import ko from 'knockout';
import { systemInfo, collectDiagnosticsState } from 'model';
import { downloadSystemDiagnosticPack, setSystemDebugLevel } from 'actions';
import { support } from 'config';

class DiagnosticsFormViewModel extends Disposable {
    constructor() {
        super();

        this.contactSupport = [
            {
                label: 'By email',
                value: `<a class="link" href="mailto:${support.email}">${support.email}</a>`
            },
            {
                label: 'Support center',
                value: `<a class="link" href="${support.helpDesk}" target="_blank">${support.helpDesk}</a>`
            }
        ];

        this.debugMode = ko.pureComputed(
            () => Boolean(systemInfo() && systemInfo().debug_level)
        );

        this.debugModeSheet = [
            {
                label: 'Debug Mode',
                value: ko.pureComputed(
                    () => this.debugMode() ?
                        'On <span class="warning">(May cause server slowdown)</span>' :
                        'Off'
                )
            },
            {
                label: 'Time Left For Debugging',
                value: ko.pureComputed(
                    () => 'None'
                )
            }
        ];

        this.toogleDebugModeButtonText = ko.pureComputed(
            () => `Turn ${this.debugMode() ? 'Off' : 'On' } Debug Mode`
        );

        this.isCollectingDiagnostics = ko.pureComputed(
            () => Boolean(collectDiagnosticsState()['system'])
        );
    }

    toogleDebugMode() {
        setSystemDebugLevel(this.debugMode() ? 0 : 5);
    }

    downloadDiagnosticPack() {
        downloadSystemDiagnosticPack();
    }
}

export default {
    viewModel: DiagnosticsFormViewModel,
    template: template
};
