/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { dispose, toDisposable } from '../../../../base/common/lifecycle.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { ViewContext } from '../../../common/viewModel/viewContext.js';
import type { IObjectCollectionBufferEntry } from '../../gpu/objectCollectionBuffer.js';
import type { RectangleRendererEntrySpec } from '../../gpu/rectangleRenderer.js';
import { ViewGpuContext } from '../../gpu/viewGpuContext.js';
import { DynamicViewOverlay } from '../../view/dynamicViewOverlay.js';
import { RenderingContext, type HorizontalRange, type LineVisibleRanges, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { ViewLineOptions } from '../viewLines/viewLineOptions.js';

const enum CornerStyle {
	EXTERN,
	INTERN,
	FLAT
}

interface IVisibleRangeEndPointStyle {
	top: CornerStyle;
	bottom: CornerStyle;
}

class HorizontalRangeWithStyle {
	public left: number;
	public width: number;
	public startStyle: IVisibleRangeEndPointStyle | null;
	public endStyle: IVisibleRangeEndPointStyle | null;

	constructor(other: HorizontalRange) {
		this.left = other.left;
		this.width = other.width;
		this.startStyle = null;
		this.endStyle = null;
	}
}

class LineVisibleRangesWithStyle {
	public lineNumber: number;
	public ranges: HorizontalRangeWithStyle[];

	constructor(lineNumber: number, ranges: HorizontalRangeWithStyle[]) {
		this.lineNumber = lineNumber;
		this.ranges = ranges;
	}
}

function toStyledRange(item: HorizontalRange): HorizontalRangeWithStyle {
	return new HorizontalRangeWithStyle(item);
}

function toStyled(item: LineVisibleRanges): LineVisibleRangesWithStyle {
	return new LineVisibleRangesWithStyle(item.lineNumber, item.ranges.map(toStyledRange));
}

/**
 * This view part displays selected text to the user. Every line has its own selection overlay.
 */
export class SelectionsGpu extends ViewPart {

	private readonly _gpuShapes: IObjectCollectionBufferEntry<RectangleRendererEntrySpec>[] = [];

	private _roundedSelection: boolean;
	private _typicalHalfwidthCharacterWidth: number;
	private _selections: Range[];
	private _renderResult: string[] | null;

	constructor(
		context: ViewContext,
		private readonly _viewGpuContext: ViewGpuContext
	) {
		super(context);
		const options = this._context.configuration.options;
		this._roundedSelection = options.get(EditorOption.roundedSelection);
		this._typicalHalfwidthCharacterWidth = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
		this._selections = [];
		this._renderResult = null;
		this._context.addEventHandler(this);
		this._register(toDisposable(() => {
			this._context.removeEventHandler(this);
			this._renderResult = null;
		}));
	}

	// --- begin event handlers

	public override onConfigurationChanged(e: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		this._roundedSelection = options.get(EditorOption.roundedSelection);
		this._typicalHalfwidthCharacterWidth = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
		return true;
	}
	public override onCursorStateChanged(e: viewEvents.ViewCursorStateChangedEvent): boolean {
		this._selections = e.selections.slice(0);
		return true;
	}

	// --- end event handlers

	private _visibleRangesHaveGaps(linesVisibleRanges: LineVisibleRangesWithStyle[]): boolean {

		for (let i = 0, len = linesVisibleRanges.length; i < len; i++) {
			const lineVisibleRanges = linesVisibleRanges[i];

			if (lineVisibleRanges.ranges.length > 1) {
				// There are two ranges on the same line
				return true;
			}
		}

		return false;
	}

	private _enrichVisibleRangesWithStyle(viewport: Range, linesVisibleRanges: LineVisibleRangesWithStyle[], previousFrame: LineVisibleRangesWithStyle[] | null): void {
		const epsilon = this._typicalHalfwidthCharacterWidth / 4;
		let previousFrameTop: HorizontalRangeWithStyle | null = null;
		let previousFrameBottom: HorizontalRangeWithStyle | null = null;

		if (previousFrame && previousFrame.length > 0 && linesVisibleRanges.length > 0) {

			const topLineNumber = linesVisibleRanges[0].lineNumber;
			if (topLineNumber === viewport.startLineNumber) {
				for (let i = 0; !previousFrameTop && i < previousFrame.length; i++) {
					if (previousFrame[i].lineNumber === topLineNumber) {
						previousFrameTop = previousFrame[i].ranges[0];
					}
				}
			}

			const bottomLineNumber = linesVisibleRanges[linesVisibleRanges.length - 1].lineNumber;
			if (bottomLineNumber === viewport.endLineNumber) {
				for (let i = previousFrame.length - 1; !previousFrameBottom && i >= 0; i--) {
					if (previousFrame[i].lineNumber === bottomLineNumber) {
						previousFrameBottom = previousFrame[i].ranges[0];
					}
				}
			}

			if (previousFrameTop && !previousFrameTop.startStyle) {
				previousFrameTop = null;
			}
			if (previousFrameBottom && !previousFrameBottom.startStyle) {
				previousFrameBottom = null;
			}
		}

		for (let i = 0, len = linesVisibleRanges.length; i < len; i++) {
			// We know for a fact that there is precisely one range on each line
			const curLineRange = linesVisibleRanges[i].ranges[0];
			const curLeft = curLineRange.left;
			const curRight = curLineRange.left + curLineRange.width;

			const startStyle = {
				top: CornerStyle.EXTERN,
				bottom: CornerStyle.EXTERN
			};

			const endStyle = {
				top: CornerStyle.EXTERN,
				bottom: CornerStyle.EXTERN
			};

			if (i > 0) {
				// Look above
				const prevLeft = linesVisibleRanges[i - 1].ranges[0].left;
				const prevRight = linesVisibleRanges[i - 1].ranges[0].left + linesVisibleRanges[i - 1].ranges[0].width;

				if (abs(curLeft - prevLeft) < epsilon) {
					startStyle.top = CornerStyle.FLAT;
				} else if (curLeft > prevLeft) {
					startStyle.top = CornerStyle.INTERN;
				}

				if (abs(curRight - prevRight) < epsilon) {
					endStyle.top = CornerStyle.FLAT;
				} else if (prevLeft < curRight && curRight < prevRight) {
					endStyle.top = CornerStyle.INTERN;
				}
			} else if (previousFrameTop) {
				// Accept some hiccups near the viewport edges to save on repaints
				startStyle.top = previousFrameTop.startStyle!.top;
				endStyle.top = previousFrameTop.endStyle!.top;
			}

			if (i + 1 < len) {
				// Look below
				const nextLeft = linesVisibleRanges[i + 1].ranges[0].left;
				const nextRight = linesVisibleRanges[i + 1].ranges[0].left + linesVisibleRanges[i + 1].ranges[0].width;

				if (abs(curLeft - nextLeft) < epsilon) {
					startStyle.bottom = CornerStyle.FLAT;
				} else if (nextLeft < curLeft && curLeft < nextRight) {
					startStyle.bottom = CornerStyle.INTERN;
				}

				if (abs(curRight - nextRight) < epsilon) {
					endStyle.bottom = CornerStyle.FLAT;
				} else if (curRight < nextRight) {
					endStyle.bottom = CornerStyle.INTERN;
				}
			} else if (previousFrameBottom) {
				// Accept some hiccups near the viewport edges to save on repaints
				startStyle.bottom = previousFrameBottom.startStyle!.bottom;
				endStyle.bottom = previousFrameBottom.endStyle!.bottom;
			}

			curLineRange.startStyle = startStyle;
			curLineRange.endStyle = endStyle;
		}
	}

	private _getVisibleRangesWithStyle(selection: Range, ctx: RenderingContext, previousFrame: LineVisibleRangesWithStyle[] | null): LineVisibleRangesWithStyle[] {
		const _linesVisibleRanges = ctx.linesVisibleRangesForRange(selection, true) || [];
		const linesVisibleRanges = _linesVisibleRanges.map(toStyled);
		const visibleRangesHaveGaps = this._visibleRangesHaveGaps(linesVisibleRanges);

		if (!visibleRangesHaveGaps && this._roundedSelection) {
			this._enrichVisibleRangesWithStyle(ctx.visibleRange, linesVisibleRanges, previousFrame);
		}

		// The visible ranges are sorted TOP-BOTTOM and LEFT-RIGHT
		return linesVisibleRanges;
	}

	private _createSelectionPiece(top: number, bottom: number, className: string, left: number, width: number): string {
		return (
			'<div class="cslr '
			+ className
			+ '" style="'
			+ 'top:' + top.toString() + 'px;'
			+ 'bottom:' + bottom.toString() + 'px;'
			+ 'left:' + left.toString() + 'px;'
			+ 'width:' + width.toString() + 'px;'
			+ '"></div>'
		);
	}

	private _actualRenderOneSelection(output2: [string, string][], visibleStartLineNumber: number, hasMultipleSelections: boolean, visibleRanges: LineVisibleRangesWithStyle[]): void {
	}

	// private _actualRenderOneSelection(output2: [string, string][], visibleStartLineNumber: number, hasMultipleSelections: boolean, visibleRanges: LineVisibleRangesWithStyle[]): void {
	// 	if (visibleRanges.length === 0) {
	// 		return;
	// 	}

	// 	const visibleRangesHaveStyle = !!visibleRanges[0].ranges[0].startStyle;

	// 	const firstLineNumber = visibleRanges[0].lineNumber;
	// 	const lastLineNumber = visibleRanges[visibleRanges.length - 1].lineNumber;

	// 	for (let i = 0, len = visibleRanges.length; i < len; i++) {
	// 		const lineVisibleRanges = visibleRanges[i];
	// 		const lineNumber = lineVisibleRanges.lineNumber;
	// 		const lineIndex = lineNumber - visibleStartLineNumber;

	// 		const top = hasMultipleSelections ? (lineNumber === firstLineNumber ? 1 : 0) : 0;
	// 		const bottom = hasMultipleSelections ? (lineNumber !== firstLineNumber && lineNumber === lastLineNumber ? 1 : 0) : 0;

	// 		let innerCornerOutput = '';
	// 		let restOfSelectionOutput = '';

	// 		for (let j = 0, lenJ = lineVisibleRanges.ranges.length; j < lenJ; j++) {
	// 			const visibleRange = lineVisibleRanges.ranges[j];

	// 			if (visibleRangesHaveStyle) {
	// 				const startStyle = visibleRange.startStyle!;
	// 				const endStyle = visibleRange.endStyle!;
	// 				if (startStyle.top === CornerStyle.INTERN || startStyle.bottom === CornerStyle.INTERN) {
	// 					// Reverse rounded corner to the left

	// 					// First comes the selection (blue layer)
	// 					innerCornerOutput += this._createSelectionPiece(top, bottom, SelectionsOverlay.SELECTION_CLASS_NAME, visibleRange.left - SelectionsOverlay.ROUNDED_PIECE_WIDTH, SelectionsOverlay.ROUNDED_PIECE_WIDTH);

	// 					// Second comes the background (white layer) with inverse border radius
	// 					let className = SelectionsOverlay.EDITOR_BACKGROUND_CLASS_NAME;
	// 					if (startStyle.top === CornerStyle.INTERN) {
	// 						className += ' ' + SelectionsOverlay.SELECTION_TOP_RIGHT;
	// 					}
	// 					if (startStyle.bottom === CornerStyle.INTERN) {
	// 						className += ' ' + SelectionsOverlay.SELECTION_BOTTOM_RIGHT;
	// 					}
	// 					innerCornerOutput += this._createSelectionPiece(top, bottom, className, visibleRange.left - SelectionsOverlay.ROUNDED_PIECE_WIDTH, SelectionsOverlay.ROUNDED_PIECE_WIDTH);
	// 				}
	// 				if (endStyle.top === CornerStyle.INTERN || endStyle.bottom === CornerStyle.INTERN) {
	// 					// Reverse rounded corner to the right

	// 					// First comes the selection (blue layer)
	// 					innerCornerOutput += this._createSelectionPiece(top, bottom, SelectionsOverlay.SELECTION_CLASS_NAME, visibleRange.left + visibleRange.width, SelectionsOverlay.ROUNDED_PIECE_WIDTH);

	// 					// Second comes the background (white layer) with inverse border radius
	// 					let className = SelectionsOverlay.EDITOR_BACKGROUND_CLASS_NAME;
	// 					if (endStyle.top === CornerStyle.INTERN) {
	// 						className += ' ' + SelectionsOverlay.SELECTION_TOP_LEFT;
	// 					}
	// 					if (endStyle.bottom === CornerStyle.INTERN) {
	// 						className += ' ' + SelectionsOverlay.SELECTION_BOTTOM_LEFT;
	// 					}
	// 					innerCornerOutput += this._createSelectionPiece(top, bottom, className, visibleRange.left + visibleRange.width, SelectionsOverlay.ROUNDED_PIECE_WIDTH);
	// 				}
	// 			}

	// 			let className = SelectionsOverlay.SELECTION_CLASS_NAME;
	// 			if (visibleRangesHaveStyle) {
	// 				const startStyle = visibleRange.startStyle!;
	// 				const endStyle = visibleRange.endStyle!;
	// 				if (startStyle.top === CornerStyle.EXTERN) {
	// 					className += ' ' + SelectionsOverlay.SELECTION_TOP_LEFT;
	// 				}
	// 				if (startStyle.bottom === CornerStyle.EXTERN) {
	// 					className += ' ' + SelectionsOverlay.SELECTION_BOTTOM_LEFT;
	// 				}
	// 				if (endStyle.top === CornerStyle.EXTERN) {
	// 					className += ' ' + SelectionsOverlay.SELECTION_TOP_RIGHT;
	// 				}
	// 				if (endStyle.bottom === CornerStyle.EXTERN) {
	// 					className += ' ' + SelectionsOverlay.SELECTION_BOTTOM_RIGHT;
	// 				}
	// 			}
	// 			restOfSelectionOutput += this._createSelectionPiece(top, bottom, className, visibleRange.left, visibleRange.width);
	// 		}

	// 		output2[lineIndex][0] += innerCornerOutput;
	// 		output2[lineIndex][1] += restOfSelectionOutput;
	// 	}
	// }

	private _previousFrameVisibleRangesWithStyle: (LineVisibleRangesWithStyle[] | null)[] = [];
	public prepareRender(ctx: RenderingContext): void {
		console.log('selections prepareRender');

		// Build HTML for inner corners separate from HTML for the rest of selections,
		// as the inner corner HTML can interfere with that of other selections.
		// In final render, make sure to place the inner corner HTML before the rest of selection HTML. See issue #77777.
		// const output: [string, string][] = [];
		// const visibleStartLineNumber = ctx.visibleRange.startLineNumber;
		// const visibleEndLineNumber = ctx.visibleRange.endLineNumber;
		// for (let lineNumber = visibleStartLineNumber; lineNumber <= visibleEndLineNumber; lineNumber++) {
		// 	const lineIndex = lineNumber - visibleStartLineNumber;
		// 	output[lineIndex] = ['', ''];
		// }



		console.log('selections', this._selections);
		dispose(this._gpuShapes);
		this._gpuShapes.length = 0;
		const options = new ViewLineOptions(this._context.configuration, this._context.theme.type);
		for (const selection of this._selections) {
			if (selection.isEmpty()) {
				continue;
			}
			if (ViewGpuContext.canRender(options, ctx.viewportData, selection.startLineNumber)) {
				console.log('render selection', selection.startLineNumber, selection.startColumn);
				this._gpuShapes.push(this._viewGpuContext.rectangleRenderer.register(selection.startColumn * 10, selection.startLineNumber * 10, 100, 10, 1, 0, 0, 1));
			}
		}
		// this._gpuShapes.push(this._viewGpuContext.rectangleRenderer.register(100, 100, 200, 100, 1, 0, 0, 1));

		// const thisFrameVisibleRangesWithStyle: (LineVisibleRangesWithStyle[] | null)[] = [];
		// for (let i = 0, len = this._selections.length; i < len; i++) {
		// 	const selection = this._selections[i];
		// 	if (selection.isEmpty()) {
		// 		thisFrameVisibleRangesWithStyle[i] = null;
		// 		continue;
		// 	}

		// 	const visibleRangesWithStyle = this._getVisibleRangesWithStyle(selection, ctx, this._previousFrameVisibleRangesWithStyle[i]);
		// 	thisFrameVisibleRangesWithStyle[i] = visibleRangesWithStyle;
		// 	this._actualRenderOneSelection(output, visibleStartLineNumber, this._selections.length > 1, visibleRangesWithStyle);
		// }

		// this._previousFrameVisibleRangesWithStyle = thisFrameVisibleRangesWithStyle;
		// this._renderResult = output.map(([internalCorners, restOfSelection]) => internalCorners + restOfSelection);
	}

	public override render(ctx: RestrictedRenderingContext): void {
		// if (!this._renderResult) {
		// 	return '';
		// }
		// const lineIndex = lineNumber - startLineNumber;
		// if (lineIndex < 0 || lineIndex >= this._renderResult.length) {
		// 	return '';
		// }
		// return this._renderResult[lineIndex];
	}

	// private _updateEntries(reader: IReader | undefined) {
	// 	const options = this._context.configuration.options;
	// 	const rulers = options.get(EditorOption.rulers);
	// 	const typicalHalfwidthCharacterWidth = options.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
	// 	const devicePixelRatio = this._viewGpuContext.devicePixelRatio.read(reader);
	// 	for (let i = 0, len = rulers.length; i < len; i++) {
	// 		const ruler = rulers[i];
	// 		const shape = this._gpuShapes[i];
	// 		const color = ruler.color ? Color.fromHex(ruler.color) : this._context.theme.getColor(editorRuler) ?? Color.white;
	// 		const rulerData = [
	// 			ruler.column * typicalHalfwidthCharacterWidth * devicePixelRatio,
	// 			0,
	// 			Math.max(1, Math.ceil(devicePixelRatio)),
	// 			Number.MAX_SAFE_INTEGER,
	// 			color.rgba.r / 255,
	// 			color.rgba.g / 255,
	// 			color.rgba.b / 255,
	// 			color.rgba.a,
	// 		] as const;
	// 		if (!shape) {
	// 			this._gpuShapes[i] = this._viewGpuContext.rectangleRenderer.register(...rulerData);
	// 		} else {
	// 			shape.setRaw(rulerData);
	// 		}
	// 	}
	// 	while (this._gpuShapes.length > rulers.length) {
	// 		this._gpuShapes.splice(-1, 1)[0].dispose();
	// 	}
	// }
}

function abs(n: number): number {
	return n < 0 ? -n : n;
}
